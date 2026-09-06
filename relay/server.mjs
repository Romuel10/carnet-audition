import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const APP_SHARED_SECRET = process.env.APP_SHARED_SECRET || '';
const LIVE_MODEL = process.env.OPENAI_LIVE_MODEL || 'gpt-live-transcribe';
const FINAL_MODEL = process.env.OPENAI_FINAL_MODEL || 'gpt-transcribe';
const LIVE_DELAY = ['minimal','low','medium','high','xhigh'].includes(process.env.OPENAI_LIVE_DELAY || '')
  ? process.env.OPENAI_LIVE_DELAY : 'low';
const REALTIME_URL = process.env.OPENAI_REALTIME_URL || `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(LIVE_MODEL)}`;
const TRANSCRIPTION_URL = process.env.OPENAI_TRANSCRIPTION_URL || 'https://api.openai.com/v1/audio/transcriptions';
const INPUT_SAMPLE_RATE = 16000;
const REALTIME_SAMPLE_RATE = 24000;
const BYTES_PER_SECOND = INPUT_SAMPLE_RATE * 2;
const MAX_SESSION_BYTES = BYTES_PER_SECOND * 60 * 20;
const FINAL_REFINEMENT = String(process.env.OPENAI_FINAL_REFINEMENT ?? 'true').toLowerCase() !== 'false';

if (!OPENAI_API_KEY) console.warn('OPENAI_API_KEY absent : les transcriptions échoueront tant que la variable n’est pas définie.');
if (!APP_SHARED_SECRET) console.warn('APP_SHARED_SECRET absent : le relais n’exige aucun jeton client. À éviter en production.');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({
      ok:true,
      service:'assistant-pv-transcription-relay',
      mode:'openai-realtime-transcription',
      liveModel:LIVE_MODEL,
      finalModel:FINAL_MODEL,
      liveDelay:LIVE_DELAY,
      finalRefinement:FINAL_REFINEMENT,
      inputSampleRate:INPUT_SAMPLE_RATE,
      realtimeSampleRate:REALTIME_SAMPLE_RATE,
    }));
    return;
  }
  res.writeHead(404, {'content-type':'text/plain; charset=utf-8'});
  res.end('Not found');
});

const wss = new WebSocketServer({server, perMessageDeflate:false, maxPayload:2 * 1024 * 1024});

wss.on('connection', (client, req) => {
  const ctx = {
    initialized:false,
    tokenAccepted:false,
    prompt:'',
    keywords:[],
    language:'mg',
    full:[],
    fullBytes:0,
    liveText:'',
    liveFinal:'',
    refinedText:'',
    stopped:false,
    committed:false,
    upstream:null,
    upstreamReady:false,
    audioQueue:[],
    resampler:createResampler16to24(),
    remoteAddress:req.socket?.remoteAddress || '',
    startedAt:Date.now(),
  };

  const send = data => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  };

  const authorize = token => {
    if (!APP_SHARED_SECRET) return true;
    return typeof token === 'string' && token.length > 0 && timingSafeTextEqual(token, APP_SHARED_SECRET);
  };

  const closeUpstream = () => {
    try {
      if (ctx.upstream && [WebSocket.OPEN, WebSocket.CONNECTING].includes(ctx.upstream.readyState)) ctx.upstream.close();
    } catch {}
  };

  client.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return send({type:'error', message:'Message invalide.'}); }

    if (msg.type === 'ping') {
      if (!authorize(msg.token || '')) return send({type:'error', message:'Jeton du relais refusé.'});
      return send({type:'pong', mode:'realtime', liveModel:LIVE_MODEL, finalModel:FINAL_MODEL});
    }

    if (msg.type === 'init') {
      if (ctx.initialized) return;
      if (!authorize(msg.token || '')) {
        send({type:'error', message:'Jeton du relais refusé.'});
        try { client.close(1008, 'Unauthorized'); } catch {}
        return;
      }
      if (!OPENAI_API_KEY) return send({type:'error', message:'Service de transcription non configuré côté serveur.'});
      ctx.initialized = true;
      ctx.tokenAccepted = true;
      ctx.language = String(msg.language || 'mg').toLowerCase().startsWith('fr') ? 'fr' : 'mg';
      ctx.prompt = sanitizePrompt(msg.prompt || '');
      ctx.keywords = sanitizeKeywords(msg.keywords || []);
      try {
        await openRealtimeSession(ctx, send);
      } catch (error) {
        send({type:'error', message:cleanError(error)});
      }
      return;
    }

    if (!ctx.initialized) return send({type:'error', message:'Session non initialisée.'});

    if (msg.type === 'audio') {
      if (ctx.stopped) return;
      let chunk;
      try { chunk = Buffer.from(String(msg.audio || ''), 'base64'); }
      catch { return; }
      if (!chunk.length) return;
      if (ctx.fullBytes + chunk.length > MAX_SESSION_BYTES) {
        ctx.stopped = true;
        send({type:'error', message:'Enregistrement trop long pour la transcription en ligne de cette version.'});
        closeUpstream();
        return;
      }
      if (chunk.length % 2) chunk = chunk.subarray(0, chunk.length - 1);
      if (!chunk.length) return;
      ctx.full.push(chunk);
      ctx.fullBytes += chunk.length;
      const pcm24 = resamplePcm16To24(ctx.resampler, chunk);
      if (pcm24.length) forwardRealtimeAudio(ctx, pcm24);
      return;
    }

    if (msg.type === 'stop') {
      if (ctx.stopped) return;
      ctx.stopped = true;
      send({type:'status', value:'finalizing_live'});
      try {
        const tail = flushResampler(ctx.resampler);
        if (tail.length) forwardRealtimeAudio(ctx, tail);
        await commitRealtimeTurn(ctx);
      } catch (error) {
        send({type:'error', message:cleanError(error)});
      }
      return;
    }
  });

  client.on('close', closeUpstream);
  client.on('error', closeUpstream);
});

function openRealtimeSession(ctx, send) {
  return new Promise((resolve, reject) => {
    const upstream = new WebSocket(REALTIME_URL, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      perMessageDeflate:false,
      handshakeTimeout:12000,
    });
    ctx.upstream = upstream;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { upstream.close(); } catch {}
        reject(new Error('Délai de connexion au moteur de transcription dépassé.'));
      }
    }, 12000);

    upstream.on('open', () => {
      const transcription = {
        model: LIVE_MODEL,
        prompt: buildRealtimePrompt(ctx),
        delay: LIVE_DELAY,
      };
      if (ctx.keywords.length) transcription.keywords = ctx.keywords;
      // Pour Malagasy, on laisse le modèle détecter la langue : certains déploiements
      // Realtime peuvent refuser un code de langue non listé. Pour le français seul,
      // le hint explicite améliore la stabilité sans nuire au code-switching Malagasy/FR.
      if (ctx.language === 'fr') transcription.languages = ['fr'];

      upstream.send(JSON.stringify({
        type:'session.update',
        session:{
          type:'transcription',
          audio:{
            input:{
              format:{type:'audio/pcm', rate:REALTIME_SAMPLE_RATE},
              transcription,
              turn_detection:null,
            }
          }
        }
      }));
      ctx.upstreamReady = true;
      for (const queued of ctx.audioQueue.splice(0)) appendRealtimeAudio(ctx, queued);
      send({type:'ready', mode:'realtime', liveModel:LIVE_MODEL, finalModel:FINAL_MODEL, delay:LIVE_DELAY});
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });

    upstream.on('message', raw => {
      let event;
      try { event = JSON.parse(raw.toString()); }
      catch { return; }

      if (event.type === 'conversation.item.input_audio_transcription.delta') {
        const delta = String(event.delta || '');
        if (!delta) return;
        ctx.liveText += delta;
        send({
          type:'partial',
          text:ctx.liveText.trim(),
          delta,
          model:LIVE_MODEL,
          realtime:true,
        });
        return;
      }

      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const transcript = String(event.transcript || ctx.liveText || '').trim();
        ctx.liveFinal = transcript;
        send({
          type:'final',
          text:transcript,
          model:LIVE_MODEL,
          realtime:true,
          refinementPending:FINAL_REFINEMENT && ctx.fullBytes > 0,
        });
        if (FINAL_REFINEMENT && ctx.fullBytes > 0) {
          refineCompletedTurn(ctx, send).catch(error => {
            send({type:'refinement_error', message:cleanError(error)});
            send({type:'done', text:ctx.liveFinal, model:LIVE_MODEL});
            try { upstream.close(); } catch {}
          });
        } else {
          send({type:'done', text:transcript, model:LIVE_MODEL});
          setTimeout(() => { try { upstream.close(); } catch {} }, 100);
        }
        return;
      }

      if (event.type === 'error') {
        const message = event?.error?.message || event?.message || 'Erreur du moteur Realtime.';
        send({type:'error', message:String(message).slice(0,360)});
      }
    });

    upstream.on('error', error => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      } else if (!ctx.stopped) {
        send({type:'error', message:'Connexion au moteur de transcription interrompue.'});
      }
    });

    upstream.on('close', () => {
      clearTimeout(timer);
      if (!ctx.stopped && !ctx.liveFinal) send({type:'error', message:'Connexion au moteur de transcription fermée.'});
    });
  });
}

function forwardRealtimeAudio(ctx, pcm24) {
  if (!pcm24?.length) return;
  if (ctx.upstreamReady && ctx.upstream?.readyState === WebSocket.OPEN) appendRealtimeAudio(ctx, pcm24);
  else {
    ctx.audioQueue.push(pcm24);
    while (ctx.audioQueue.length > 80) ctx.audioQueue.shift();
  }
}

function appendRealtimeAudio(ctx, pcm24) {
  if (ctx.upstream?.readyState !== WebSocket.OPEN) return;
  ctx.upstream.send(JSON.stringify({type:'input_audio_buffer.append', audio:pcm24.toString('base64')}));
}

async function commitRealtimeTurn(ctx) {
  const deadline = Date.now() + 5000;
  while (!ctx.upstreamReady && Date.now() < deadline) await delay(30);
  if (ctx.upstream?.readyState !== WebSocket.OPEN) throw new Error('Moteur de transcription en ligne non connecté.');
  if (!ctx.committed) {
    ctx.committed = true;
    ctx.upstream.send(JSON.stringify({type:'input_audio_buffer.commit'}));
  }
}

async function refineCompletedTurn(ctx, send) {
  send({type:'status', value:'refining'});
  const pcm = Buffer.concat(ctx.full);
  const started = Date.now();
  const refined = await transcribePcmFile(pcm, FINAL_MODEL, buildFinalPrompt(ctx));
  ctx.refinedText = String(refined || '').trim();
  const chosen = chooseRefinedText(ctx.liveFinal, ctx.refinedText);
  if (chosen) {
    send({
      type:'refined',
      text:chosen,
      liveText:ctx.liveFinal,
      model:FINAL_MODEL,
      latencyMs:Date.now()-started,
    });
  }
  send({type:'done', text:chosen || ctx.liveFinal, model:chosen ? FINAL_MODEL : LIVE_MODEL});
  setTimeout(() => { try { ctx.upstream?.close(); } catch {} }, 120);
}

async function transcribePcmFile(pcm, model, prompt) {
  const wav = makeWav(pcm, INPUT_SAMPLE_RATE);
  const form = new FormData();
  form.append('file', new Blob([wav], {type:'audio/wav'}), 'speech.wav');
  form.append('model', model);
  if (prompt) form.append('prompt', String(prompt).slice(0, 1800));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(TRANSCRIPTION_URL, {
      method:'POST',
      headers:{Authorization:`Bearer ${OPENAI_API_KEY}`},
      body:form,
      signal:controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      let detail = body;
      try { detail = JSON.parse(body)?.error?.message || body; } catch {}
      throw new Error(`Finalisation distante refusée (${response.status}) : ${detail}`);
    }
    let json;
    try { json = JSON.parse(body); } catch { return body.trim(); }
    return String(json?.text || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

function chooseRefinedText(live, refined) {
  const a = String(live || '').trim();
  const b = String(refined || '').trim();
  if (!b) return a;
  if (!a) return b;
  // Évite qu'une finalisation manifestement tronquée remplace un texte live plus complet.
  const aWords = a.split(/\s+/).filter(Boolean).length;
  const bWords = b.split(/\s+/).filter(Boolean).length;
  if (aWords >= 8 && bWords < Math.max(3, Math.floor(aWords * 0.45))) return a;
  return b;
}

function buildRealtimePrompt(ctx) {
  const languageInstruction = ctx.language === 'fr'
    ? 'Transcrire fidèlement en français. Des noms malagasy peuvent apparaître.'
    : 'Transcrire fidèlement la parole en malagasy de Madagascar. Des mots et expressions juridiques en français peuvent apparaître dans la même phrase. Ne pas traduire.';
  return [languageInstruction, ctx.prompt].filter(Boolean).join('\n').slice(0,1800);
}

function buildFinalPrompt(ctx) {
  return [
    'Transcription fidèle d’une audition. Ne pas résumer, ne pas compléter ce qui n’est pas prononcé et ne pas traduire.',
    ctx.language === 'fr'
      ? 'Langue principale : français, avec noms propres malagasy possibles.'
      : 'Langue principale : malagasy de Madagascar, avec code-switching français possible.',
    ctx.prompt,
  ].filter(Boolean).join('\n').slice(0,1800);
}

function sanitizePrompt(value) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,' ').trim().slice(0,1600);
}

function sanitizeKeywords(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/\n+/);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const word = String(raw || '').replace(/[<>\r\n]/g,' ').replace(/\s+/g,' ').trim().slice(0,100);
    const key = word.toLocaleLowerCase('fr');
    if (!word || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= 80) break;
  }
  return out;
}

function createResampler16to24() {
  return { totalInputSamples:0, nextPositionThirds:0, hasPrev:false, prev:0 };
}

function resamplePcm16To24(state, input) {
  const count = Math.floor(input.length / 2);
  if (!count) return Buffer.alloc(0);
  const fresh = new Int16Array(count);
  for (let i=0;i<count;i++) fresh[i] = input.readInt16LE(i*2);
  const combinedStart = state.hasPrev ? state.totalInputSamples - 1 : state.totalInputSamples;
  const combined = new Int16Array(count + (state.hasPrev ? 1 : 0));
  let offset = 0;
  if (state.hasPrev) { combined[0] = state.prev; offset = 1; }
  combined.set(fresh, offset);
  const newTotal = state.totalInputSamples + count;
  const out = [];
  while (true) {
    const n = state.nextPositionThirds;
    const i0 = Math.floor(n / 3);
    const rem = n % 3;
    const i1 = rem === 0 ? i0 : i0 + 1;
    if (i1 >= newTotal) break;
    const local0 = i0 - combinedStart;
    const local1 = i1 - combinedStart;
    if (local0 < 0 || local1 < 0 || local0 >= combined.length || local1 >= combined.length) break;
    const s0 = combined[local0];
    const s1 = combined[local1];
    let sample = s0;
    if (rem === 1) sample = Math.round((2*s0 + s1) / 3);
    else if (rem === 2) sample = Math.round((s0 + 2*s1) / 3);
    out.push(Math.max(-32768, Math.min(32767, sample)));
    state.nextPositionThirds += 2;
  }
  state.totalInputSamples = newTotal;
  state.prev = fresh[fresh.length - 1];
  state.hasPrev = true;
  const buffer = Buffer.allocUnsafe(out.length * 2);
  for (let i=0;i<out.length;i++) buffer.writeInt16LE(out[i], i*2);
  return buffer;
}

function flushResampler(_state) {
  // Les dernières fractions qui exigeraient un échantillon futur sont volontairement
  // omises : au maximum quelques dizaines de microsecondes d'audio.
  return Buffer.alloc(0);
}

function makeWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF',0); header.writeUInt32LE(36 + pcm.length,4); header.write('WAVE',8);
  header.write('fmt ',12); header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(1,22);
  header.writeUInt32LE(sampleRate,24); header.writeUInt32LE(sampleRate*2,28); header.writeUInt16LE(2,32); header.writeUInt16LE(16,34);
  header.write('data',36); header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}

function delay(ms){ return new Promise(r=>setTimeout(r,ms)); }
function cleanError(error){ return error?.name === 'AbortError' ? 'Délai de transcription dépassé.' : String(error?.message || error || 'Erreur de transcription.').slice(0,360); }
function timingSafeTextEqual(a,b){
  const aa=Buffer.from(String(a)), bb=Buffer.from(String(b));
  if (aa.length!==bb.length) return false;
  let diff=0; for(let i=0;i<aa.length;i++) diff|=aa[i]^bb[i]; return diff===0;
}

server.listen(PORT, '0.0.0.0', () => console.log(`Assistant PV realtime transcription relay listening on :${PORT}`));
