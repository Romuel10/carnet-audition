import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const APP_SHARED_SECRET = process.env.APP_SHARED_SECRET || '';
const PREVIEW_MODEL = process.env.OPENAI_PREVIEW_MODEL || 'gpt-4o-mini-transcribe';
const FINAL_MODEL = process.env.OPENAI_FINAL_MODEL || 'gpt-transcribe';
const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const PREVIEW_WINDOW_BYTES = Math.round(BYTES_PER_SECOND * 1.6);
const PREVIEW_STEP_BYTES = Math.round(BYTES_PER_SECOND * 1.15);
const MAX_SESSION_BYTES = BYTES_PER_SECOND * 60 * 20;

if (!OPENAI_API_KEY) console.warn('OPENAI_API_KEY absent : les transcriptions échoueront tant que la variable n’est pas définie.');
if (!APP_SHARED_SECRET) console.warn('APP_SHARED_SECRET absent : le relais n’exige aucun jeton client. À éviter en production.');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({ok:true, service:'assistant-pv-transcription-relay', previewModel:PREVIEW_MODEL, finalModel:FINAL_MODEL}));
    return;
  }
  res.writeHead(404, {'content-type':'text/plain; charset=utf-8'});
  res.end('Not found');
});

const wss = new WebSocketServer({server, perMessageDeflate:false, maxPayload:2 * 1024 * 1024});

wss.on('connection', ws => {
  const ctx = {
    initialized:false, language:'mg', prompt:'', microProfile:'near_field',
    rolling:Buffer.alloc(0), full:[], fullBytes:0, previewText:'',
    previewBusy:false, previewAgain:false, stopped:false, finalized:false,
    startedAt:Date.now(), tokenAccepted:false,
  };

  const send = data => {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  };

  const authorize = token => {
    if (!APP_SHARED_SECRET) return true;
    return typeof token === 'string' && token.length > 0 && timingSafeTextEqual(token, APP_SHARED_SECRET);
  };

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return send({type:'error', message:'Message invalide.'}); }

    if (msg.type === 'ping') {
      if (!authorize(msg.token || '')) return send({type:'error', message:'Jeton du relais refusé.'});
      return send({type:'pong'});
    }

    if (msg.type === 'init') {
      if (!authorize(msg.token || '')) {
        send({type:'error', message:'Jeton du relais refusé.'});
        try { ws.close(1008, 'Unauthorized'); } catch {}
        return;
      }
      if (!OPENAI_API_KEY) return send({type:'error', message:'Service de transcription non configuré côté serveur.'});
      ctx.initialized = true;
      ctx.tokenAccepted = true;
      ctx.language = String(msg.language || 'mg').toLowerCase().startsWith('fr') ? 'fr' : 'mg';
      ctx.prompt = String(msg.prompt || '').slice(0, 1800);
      ctx.microProfile = msg.microProfile === 'far_field' ? 'far_field' : 'near_field';
      send({type:'ready', previewModel:PREVIEW_MODEL, finalModel:FINAL_MODEL});
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
        return send({type:'error', message:'Enregistrement trop long pour la transcription en ligne de cette version.'});
      }
      ctx.full.push(chunk);
      ctx.fullBytes += chunk.length;
      ctx.rolling = Buffer.concat([ctx.rolling, chunk]);
      schedulePreview(ctx, send).catch(error => send({type:'error', message:cleanError(error)}));
      return;
    }

    if (msg.type === 'stop') {
      if (ctx.stopped || ctx.finalized) return;
      ctx.stopped = true;
      send({type:'status', value:'finalizing'});
      try {
        while (ctx.previewBusy) await delay(80);
        const pcm = Buffer.concat(ctx.full);
        if (!pcm.length) throw new Error('Aucun audio reçu.');
        const started = Date.now();
        const text = await transcribeLongPcm(pcm, FINAL_MODEL, ctx.language, ctx.prompt);
        ctx.finalized = true;
        send({type:'final', text:text || ctx.previewText, model:FINAL_MODEL, latencyMs:Date.now()-started});
      } catch (error) {
        send({type:'error', message:cleanError(error)});
      }
      return;
    }
  });
});

async function schedulePreview(ctx, send) {
  if (ctx.previewBusy) { ctx.previewAgain = true; return; }
  if (ctx.rolling.length < PREVIEW_WINDOW_BYTES) return;
  ctx.previewBusy = true;
  try {
    do {
      ctx.previewAgain = false;
      if (ctx.rolling.length < PREVIEW_WINDOW_BYTES) break;
      const window = ctx.rolling.subarray(0, PREVIEW_WINDOW_BYTES);
      const started = Date.now();
      const prompt = [ctx.prompt, ctx.previewText ? `Texte déjà reconnu : ${ctx.previewText.slice(-700)}` : ''].filter(Boolean).join('\n');
      const segment = await transcribePcm(window, PREVIEW_MODEL, ctx.language, prompt);
      if (segment) {
        ctx.previewText = mergeText(ctx.previewText, segment);
        send({type:'partial', text:ctx.previewText, segment, model:PREVIEW_MODEL, latencyMs:Date.now()-started});
      }
      ctx.rolling = ctx.rolling.subarray(Math.min(PREVIEW_STEP_BYTES, ctx.rolling.length));
    } while (ctx.previewAgain || ctx.rolling.length >= PREVIEW_WINDOW_BYTES * 1.4);
  } finally {
    ctx.previewBusy = false;
  }
}

async function transcribeLongPcm(pcm, model, language, prompt) {
  const maxPart = BYTES_PER_SECOND * 60 * 5;
  if (pcm.length <= maxPart) return transcribePcm(pcm, model, language, prompt);
  let out = '';
  const overlap = BYTES_PER_SECOND;
  for (let offset = 0; offset < pcm.length; offset += maxPart - overlap) {
    const part = pcm.subarray(offset, Math.min(offset + maxPart, pcm.length));
    const text = await transcribePcm(part, model, language, [prompt, out ? `Texte précédent : ${out.slice(-900)}` : ''].filter(Boolean).join('\n'));
    out = mergeText(out, text);
    if (offset + maxPart >= pcm.length) break;
  }
  return out;
}

async function transcribePcm(pcm, model, language, prompt) {
  const wav = makeWav(pcm, SAMPLE_RATE);
  const form = new FormData();
  form.append('file', new Blob([wav], {type:'audio/wav'}), 'speech.wav');
  form.append('model', model);
  form.append('language', language);
  if (prompt) form.append('prompt', String(prompt).slice(0, 1800));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method:'POST',
      headers:{Authorization:`Bearer ${OPENAI_API_KEY}`},
      body:form,
      signal:controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      let detail = body;
      try { detail = JSON.parse(body)?.error?.message || body; } catch {}
      throw new Error(`Transcription distante refusée (${response.status}) : ${detail}`);
    }
    let json;
    try { json = JSON.parse(body); } catch { return body.trim(); }
    return String(json?.text || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

function makeWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF',0); header.writeUInt32LE(36 + pcm.length,4); header.write('WAVE',8);
  header.write('fmt ',12); header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(1,22);
  header.writeUInt32LE(sampleRate,24); header.writeUInt32LE(sampleRate*2,28); header.writeUInt16LE(2,32); header.writeUInt16LE(16,34);
  header.write('data',36); header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}

function mergeText(previous, next) {
  const a = String(previous || '').trim();
  const b = String(next || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (normalize(a).endsWith(normalize(b))) return a;
  const aw = a.split(/\s+/), bw = b.split(/\s+/);
  const max = Math.min(14, aw.length, bw.length);
  for (let n=max; n>=1; n--) {
    if (normalize(aw.slice(-n).join(' ')) === normalize(bw.slice(0,n).join(' '))) return `${a} ${bw.slice(n).join(' ')}`.trim();
  }
  return `${a} ${b}`.trim();
}

function normalize(value) { return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9]+/g,' ').trim().toLowerCase(); }
function delay(ms){ return new Promise(r=>setTimeout(r,ms)); }
function cleanError(error){ return error?.name === 'AbortError' ? 'Délai de transcription dépassé.' : String(error?.message || error || 'Erreur de transcription.').slice(0,360); }
function timingSafeTextEqual(a,b){
  const aa=Buffer.from(String(a)), bb=Buffer.from(String(b));
  if (aa.length!==bb.length) return false;
  let diff=0; for(let i=0;i<aa.length;i++) diff|=aa[i]^bb[i]; return diff===0;
}

server.listen(PORT, '0.0.0.0', () => console.log(`Assistant PV transcription relay listening on :${PORT}`));
