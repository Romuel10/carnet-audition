(() => {
  const APP_VERSION = '3.0.0-beta.6';
  const STORAGE_KEY = 'assistant-pv-carnet-draft-v1';
  const PROFILE_KEY = 'assistant-pv-carnet-investigator-profile-v1';
  const DB_NAME = 'assistant-pv-carnet-audio';
  const DB_VERSION = 1;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const CapacitorRuntime = window.Capacitor || null;
  const isNativeAndroid = CapacitorRuntime?.getPlatform?.() === 'android';

  function resolveNativeAudioRecorder() {
    if (!isNativeAndroid || !CapacitorRuntime) return null;
    const injected = CapacitorRuntime.Plugins?.NativeAudioRecorder;
    if (injected) return injected;
    if (typeof CapacitorRuntime.registerPlugin === 'function') {
      try { return CapacitorRuntime.registerPlugin('NativeAudioRecorder'); } catch (error) { console.warn(error); }
    }
    if (typeof CapacitorRuntime.nativePromise === 'function') {
      const call = method => (options = {}) => CapacitorRuntime.nativePromise('NativeAudioRecorder', method, options);
      return {
        diagnostics: call('diagnostics'),
        startRecording: call('startRecording'),
        stopRecording: call('stopRecording'),
        cancelRecording: call('cancelRecording'),
        getTranscriptionState: call('getTranscriptionState'),
        saveAuditionFile: call('saveAuditionFile'),
      };
    }
    return null;
  }

  const NativeAudioRecorder = resolveNativeAudioRecorder();
  const state = { exchanges: [], activeRecording: null, stream: null, saveTimer: null, profile: null };
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const uid = () => globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    setDefaultDateTime();
    bindGeneral();
    restoreDraft();
    initProfile();
    if (!state.exchanges.length) addExchange(); else renderExchanges();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
    document.addEventListener('input', scheduleSave);
    document.addEventListener('change', scheduleSave);
    updateSpeechSupportMessage();
  }

  function bindGeneral() {
    $('#addExchangeBtn').addEventListener('click', () => { addExchange(); saveDraft(); });
    $('#exportBtn').addEventListener('click', exportPackage);
    $('#newBtn').addEventListener('click', () => {
      if (!confirm('Commencer une nouvelle audition ? Le brouillon actuel et ses audios locaux seront supprimés. Votre profil enquêteur sera conservé.')) return;
      resetAll();
    });
    $('#editProfileBtn').addEventListener('click', () => setProfileEditor(true));
    $('#saveProfileBtn').addEventListener('click', saveProfileFromForm);
    $('#cancelProfileBtn').addEventListener('click', () => {
      if (!state.profile) return toast('Enregistrez d’abord votre profil enquêteur.');
      applyProfileToForm(state.profile);
      setProfileEditor(false);
    });
  }

  function setDefaultDateTime() {
    if (!$('#startDateTime').value) $('#startDateTime').value = toLocalDateTime(new Date());
  }

  function toLocalDateTime(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function readProfileFromForm() {
    return {
      grade: $('#investigatorGrade').value.trim(),
      name: $('#investigatorName').value.trim(),
      quality: $('#investigatorQuality').value || 'APJ',
      function: $('#investigatorFunction').value.trim(),
      unit: $('#investigatorUnit').value.trim(),
      updatedAt: new Date().toISOString(),
    };
  }

  function initProfile() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); } catch (_) { stored = null; }
    if (stored?.name || stored?.grade) {
      state.profile = stored;
      applyProfileToForm(stored);
      setProfileEditor(false);
      return;
    }
    const migrated = readProfileFromForm();
    if (migrated.name || migrated.grade) {
      state.profile = migrated;
      localStorage.setItem(PROFILE_KEY, JSON.stringify(migrated));
      renderProfileSummary();
      setProfileEditor(false);
      return;
    }
    setProfileEditor(true);
    renderProfileSummary();
  }

  function applyProfileToForm(profile) {
    $('#investigatorGrade').value = profile?.grade || '';
    $('#investigatorName').value = profile?.name || '';
    $('#investigatorQuality').value = profile?.quality || 'APJ';
    $('#investigatorFunction').value = profile?.function || '';
    $('#investigatorUnit').value = profile?.unit || '';
    renderProfileSummary();
  }

  function renderProfileSummary() {
    const p = state.profile;
    const el = $('#profileSummary');
    if (!p) {
      el.innerHTML = '<strong>Profil à renseigner</strong><span>Indiquez votre grade et votre nom une seule fois.</span>';
      return;
    }
    const title = [p.grade, p.name].filter(Boolean).join(' ') || 'Enquêteur';
    const meta = [p.quality, p.function, p.unit].filter(Boolean).join(' • ');
    el.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(meta || 'Profil enregistré sur ce téléphone')}</span>`;
  }

  function setProfileEditor(show) {
    $('#profileEditor').hidden = !show;
    $('#profileSummary').hidden = show;
    $('#editProfileBtn').hidden = show;
  }

  function saveProfileFromForm() {
    const p = readProfileFromForm();
    if (!p.name) return toast('Indiquez au moins le nom de l’enquêteur.');
    if (!p.grade) return toast('Indiquez le grade de l’enquêteur.');
    state.profile = p;
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    renderProfileSummary();
    setProfileEditor(false);
    saveDraft();
    toast('Profil enquêteur enregistré.');
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }

  function makeExchange(overrides = {}) {
    return {
      id: overrides.id || uid(), question: overrides.question || '', answer: overrides.answer || '',
      signatureAfter: Boolean(overrides.signatureAfter), questionClipId: overrides.questionClipId || '', answerClipId: overrides.answerClipId || '',
      questionDurationMs: Number(overrides.questionDurationMs || 0), answerDurationMs: Number(overrides.answerDurationMs || 0),
      questionMimeType: overrides.questionMimeType || '', answerMimeType: overrides.answerMimeType || '',
    };
  }

  function addExchange(overrides = {}) {
    state.exchanges.push(makeExchange(overrides));
    renderExchanges();
    requestAnimationFrame(() => $$('.exchange-card').at(-1)?.scrollIntoView({behavior:'smooth',block:'center'}));
  }

  function renderExchanges() {
    const root = $('#exchanges');
    root.innerHTML = '';
    state.exchanges.forEach((exchange, index) => {
      const fragment = $('#exchangeTemplate').content.cloneNode(true);
      const card = $('.exchange-card', fragment);
      card.dataset.exchangeId = exchange.id;
      $('.exchange-number', card).textContent = `Échange ${index + 1}`;
      $('.question-text', card).value = exchange.question;
      $('.answer-text', card).value = exchange.answer;
      $('.signature-after', card).checked = exchange.signatureAfter;
      $('.remove-exchange', card).disabled = state.exchanges.length <= 1;
      bindExchangeCard(card, exchange);
      root.appendChild(fragment);
      hydratePlayer(exchange, 'question');
      hydratePlayer(exchange, 'answer');
    });
  }

  function bindExchangeCard(card, exchange) {
    $('.question-text', card).addEventListener('input', e => { exchange.question = e.target.value; scheduleSave(); });
    $('.answer-text', card).addEventListener('input', e => { exchange.answer = e.target.value; scheduleSave(); });
    $('.signature-after', card).addEventListener('change', e => { exchange.signatureAfter = e.target.checked; scheduleSave(); });
    $('.question-record', card).addEventListener('click', () => toggleRecording(exchange, 'question', card));
    $('.answer-record', card).addEventListener('click', () => toggleRecording(exchange, 'answer', card));
    $('.remove-exchange', card).addEventListener('click', async () => {
      if (state.activeRecording) return toast('Arrêtez d’abord l’enregistrement en cours.');
      if (exchange.questionClipId) await deleteClip(exchange.questionClipId);
      if (exchange.answerClipId) await deleteClip(exchange.answerClipId);
      state.exchanges = state.exchanges.filter(x => x.id !== exchange.id);
      renderExchanges();
      saveDraft();
    });
  }

  async function toggleRecording(exchange, kind, card) {
    if (state.activeRecording) {
      if (state.activeRecording.exchangeId === exchange.id && state.activeRecording.kind === kind) stopActiveRecording();
      else toast('Un autre enregistrement est déjà en cours.');
      return;
    }
    try {
      await startRecording(exchange, kind, card);
    } catch (error) {
      console.error(error);
      const code = error?.code ? ` [${error.code}]` : '';
      toast(`${error?.message || 'Microphone indisponible.'}${code}`);
      rememberRuntimeError('Microphone', error);
    }
  }

  async function startRecording(exchange, kind, card) {
    if (NativeAudioRecorder) return startNativeRecording(exchange, kind, card);
    if (isNativeAndroid) throw new Error('Pont audio natif indisponible. Réinstallez la beta.6 puis relancez l’application.');
    return startWebRecording(exchange, kind, card);
  }

  async function startNativeRecording(exchange, kind, card) {
    const button = $(`.${kind}-record`, card);
    const status = $(`.${kind}-status`, card);
    const transcribe = $('#autoTranscription').checked;
    const language = $('#speechLanguage').value || 'mg-MG';
    const preferOffline = $('#localSpeechOnly').checked;
    const baseText = (kind === 'question' ? exchange.question : exchange.answer).trim();
    status.textContent = transcribe ? 'Ouverture du micro + transcription…' : 'Ouverture du microphone…';
    const started = await NativeAudioRecorder.startRecording({ language, transcribe, preferOffline });
    if (started?.value === false) throw new Error('Le microphone n’a pas démarré.');
    button.classList.add('recording');
    $('.record-label', button).textContent = 'Arrêter';
    status.textContent = transcribe ? 'Audio + transcription en direct…' : 'Enregistrement audio en cours…';
    const active = { exchangeId: exchange.id, kind, native: true, card, startedAt: Date.now(), baseText, pollTimer: null };
    state.activeRecording = active;
    if (transcribe && NativeAudioRecorder.getTranscriptionState) {
      active.pollTimer = setInterval(() => pollNativeTranscript(active).catch(() => {}), 250);
      pollNativeTranscript(active).catch(() => {});
    }
  }

  async function pollNativeTranscript(active, finalPass = false) {
    if (!NativeAudioRecorder?.getTranscriptionState) return;
    const data = await NativeAudioRecorder.getTranscriptionState();
    if (!data) return;
    const exchange = state.exchanges.find(x => x.id === active.exchangeId);
    const card = active.card;
    if (!exchange || !card) return;
    const text = String(data.text || '').trim();
    if (text) {
      const value = [active.baseText, text].filter(Boolean).join(active.baseText ? ' ' : '');
      const textarea = $(`.${active.kind}-text`, card);
      textarea.value = value;
      if (active.kind === 'question') exchange.question = value; else exchange.answer = value;
      scheduleSave();
    }
    const status = $(`.${active.kind}-status`, card);
    const s = String(data.status || '');
    if (!finalPass && s === 'listening') status.textContent = text ? 'Audio + texte en direct…' : 'Audio en cours • écoute de la parole…';
    if (!finalPass && s === 'unsupported') status.textContent = 'Audio en cours • transcription non prise en charge par ce moteur Android';
    if (!finalPass && s === 'error') status.textContent = `Audio en cours • transcription indisponible${data.errorMessage ? ` (${data.errorMessage})` : ''}`;
  }

  async function stopNativeRecording(active) {
    const { exchangeId, kind, card } = active;
    const exchange = state.exchanges.find(x => x.id === exchangeId);
    const button = $(`.${kind}-record`, card);
    const status = $(`.${kind}-status`, card);
    if (active.pollTimer) clearInterval(active.pollTimer);
    try {
      status.textContent = 'Enregistrement terminé • sauvegarde…';
      const result = await NativeAudioRecorder.stopRecording();
      const data = result?.value || result || {};
      const base64 = data.recordDataBase64 || '';
      if (!base64) throw new Error('Aucune donnée audio reçue.');
      const mimeType = data.mimeType || 'audio/wav';
      const blob = base64ToBlob(base64, mimeType);
      const durationMs = Number(data.msDuration || (Date.now() - active.startedAt) || 0);
      const clipId = `${exchange.id}-${kind}-${uid()}`;
      await putClip(clipId, blob);
      const oldClip = kind === 'question' ? exchange.questionClipId : exchange.answerClipId;
      if (oldClip) await deleteClip(oldClip);
      exchange[`${kind}ClipId`] = clipId;
      exchange[`${kind}DurationMs`] = durationMs;
      exchange[`${kind}MimeType`] = mimeType;
      const player = $(`.${kind}-player`, card);
      player.src = URL.createObjectURL(blob);
      player.hidden = false;
      await sleep(700);
      try { await pollNativeTranscript(active, true); } catch (_) {}
      status.textContent = `Audio + texte conservés • ${formatDuration(durationMs)}`;
      saveDraft();
    } catch (error) {
      console.error(error);
      status.textContent = 'Échec de l’enregistrement.';
      toast(error?.message || 'L’audio n’a pas pu être conservé.');
    } finally {
      button.classList.remove('recording');
      $('.record-label', button).textContent = kind === 'question' ? 'Question' : 'Réponse';
      state.activeRecording = null;
    }
  }

  async function startWebRecording(exchange, kind, card) {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Ce navigateur ne permet pas l’enregistrement audio. Utilisez Chrome récent ou l’APK.');
    if (!state.stream) state.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const mimeCandidates = ['audio/webm;codecs=opus','audio/webm','audio/mp4'];
    const mimeType = mimeCandidates.find(x => MediaRecorder.isTypeSupported?.(x)) || '';
    const recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    const startedAt = Date.now();
    recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    const button = $(`.${kind}-record`, card);
    const status = $(`.${kind}-status`, card);
    button.classList.add('recording');
    $('.record-label', button).textContent = 'Arrêter';
    status.textContent = 'Enregistrement en cours…';

    let recognition = null;
    const baseText = kind === 'question' ? exchange.question : exchange.answer;
    let finalSpeech = '';
    const autoTranscription = $('#autoTranscription')?.checked !== false;
    const preferOffline = $('#localSpeechOnly')?.checked !== false;
    if (SpeechRecognition && autoTranscription) {
      try {
        recognition = new SpeechRecognition();
        recognition.lang = $('#speechLanguage').value || 'mg-MG';
        recognition.interimResults = true;
        recognition.continuous = true;
        if (preferOffline && 'processLocally' in recognition) recognition.processLocally = true;
        recognition.onresult = event => {
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const text = event.results[i][0]?.transcript || '';
            if (event.results[i].isFinal) finalSpeech += `${text} `; else interim += text;
          }
          const value = [baseText.trim(), finalSpeech.trim(), interim.trim()].filter(Boolean).join(baseText.trim() ? ' ' : '');
          const textarea = $(`.${kind}-text`, card);
          textarea.value = value;
          if (kind === 'question') exchange.question = value; else exchange.answer = value;
        };
        recognition.onerror = event => {
          const code = String(event?.error || '');
          if (code && code !== 'aborted' && code !== 'no-speech') status.textContent = `Audio en cours • transcription indisponible (${code})`;
        };
        recognition.start();
      } catch (_error) { recognition = null; }
    }

    recorder.onstop = async () => {
      try {
        if (recognition) { try { recognition.stop(); } catch (_) {} }
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
        const durationMs = Date.now() - startedAt;
        const clipId = `${exchange.id}-${kind}-${uid()}`;
        await putClip(clipId, blob);
        const oldClip = kind === 'question' ? exchange.questionClipId : exchange.answerClipId;
        if (oldClip) await deleteClip(oldClip);
        exchange[`${kind}ClipId`] = clipId;
        exchange[`${kind}DurationMs`] = durationMs;
        exchange[`${kind}MimeType`] = blob.type;
        status.textContent = `Audio + texte conservés • ${formatDuration(durationMs)}`;
        button.classList.remove('recording');
        $('.record-label', button).textContent = kind === 'question' ? 'Question' : 'Réponse';
        const player = $(`.${kind}-player`, card);
        player.src = URL.createObjectURL(blob);
        player.hidden = false;
        saveDraft();
      } catch (error) { console.error(error); toast('L’audio n’a pas pu être conservé.'); }
      finally { state.activeRecording = null; }
    };
    state.activeRecording = { exchangeId: exchange.id, kind, recorder, recognition, card, native: false };
    recorder.start(500);
  }

  function stopActiveRecording() {
    const active = state.activeRecording;
    if (!active) return;
    if (active.native) { stopNativeRecording(active); return; }
    const rec = active.recorder;
    if (rec && rec.state !== 'inactive') rec.stop();
  }

  function base64ToBlob(base64, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
  }

  function updateSpeechSupportMessage() {
    if (isNativeAndroid) { runNativeDiagnostics(); return; }
    if (!SpeechRecognition) $('#exportStatus').textContent = 'Transcription automatique non disponible sur ce navigateur : l’audio reste enregistré et le texte peut être saisi/corrigé manuellement.';
  }

  async function runNativeDiagnostics() {
    const el = $('#exportStatus');
    if (!NativeAudioRecorder) {
      el.textContent = 'ERREUR : pont audio natif indisponible. Vérifiez que la beta.6 est bien installée.';
      return;
    }
    try {
      const d = await NativeAudioRecorder.diagnostics();
      const speech = d.liveTranscriptionSupported ? 'transcription live prête' : 'transcription live selon moteur Android';
      el.textContent = `Audio natif prêt • ${speech} • Android ${d.sdk ?? '?'} • ${d.manufacturer ?? ''} ${d.model ?? ''} • micro: ${d.permission ?? 'à demander'} • v${APP_VERSION}`;
    } catch (error) {
      el.textContent = `Diagnostic audio impossible : ${error?.message || error}`;
    }
  }

  function rememberRuntimeError(label, error) {
    const message = `${label}: ${error?.message || error || 'erreur inconnue'}`;
    try { localStorage.setItem('assistant-pv-carnet-last-error', `${new Date().toISOString()} ${message}`); } catch (_) {}
    console.error(message, error);
  }

  window.addEventListener('error', event => rememberRuntimeError('JS', event.error || event.message));
  window.addEventListener('unhandledrejection', event => rememberRuntimeError('Promise', event.reason));

  async function hydratePlayer(exchange, kind) {
    const clipId = exchange[`${kind}ClipId`];
    if (!clipId) return;
    const blob = await getClip(clipId);
    const card = document.querySelector(`[data-exchange-id="${CSS.escape(exchange.id)}"]`);
    if (!blob || !card) return;
    const player = $(`.${kind}-player`, card);
    player.src = URL.createObjectURL(blob);
    player.hidden = false;
    $(`.${kind}-status`, card).textContent = `Audio conservé • ${formatDuration(exchange[`${kind}DurationMs`])}`;
  }

  function formatDuration(ms) {
    const sec = Math.max(0, Math.round(Number(ms || 0)/1000));
    return `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
  }

  function collectDraft() {
    return {
      version: 2,
      updatedAt: new Date().toISOString(),
      investigatorGrade: $('#investigatorGrade').value,
      investigatorName: $('#investigatorName').value,
      investigatorQuality: $('#investigatorQuality').value,
      investigatorFunction: $('#investigatorFunction').value,
      investigatorUnit: $('#investigatorUnit').value,
      personRole: $('#personRole').value,
      speechLanguage: $('#speechLanguage').value,
      autoTranscription: $('#autoTranscription').checked,
      localSpeechOnly: $('#localSpeechOnly').checked,
      personIdentity: $('#personIdentity').value,
      identityVerification: $('#identityVerification').value,
      place: $('#place').value,
      startDateTime: $('#startDateTime').value,
      endDateTime: $('#endDateTime').value,
      closingFormula: $('#closingFormula').value,
      personSignatureLabel: $('#personSignatureLabel').value,
      exchanges: state.exchanges.map(x => ({...x})),
    };
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    $('#saveState').textContent = 'Modifications…';
    state.saveTimer = setTimeout(saveDraft, 250);
  }

  function saveDraft() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collectDraft()));
    $('#saveState').textContent = 'Brouillon enregistré';
  }

  function restoreDraft() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { d = null; }
    if (!d) return;
    const ids = ['investigatorGrade','investigatorName','investigatorQuality','investigatorFunction','investigatorUnit','personRole','speechLanguage','personIdentity','identityVerification','place','startDateTime','endDateTime','closingFormula','personSignatureLabel'];
    ids.forEach(id => { if (d[id] !== undefined && $(`#${id}`)) $(`#${id}`).value = d[id]; });
    if (d.autoTranscription !== undefined) $('#autoTranscription').checked = Boolean(d.autoTranscription);
    if (d.localSpeechOnly !== undefined) $('#localSpeechOnly').checked = Boolean(d.localSpeechOnly);
    state.exchanges = Array.isArray(d.exchanges) ? d.exchanges.map(makeExchange) : [];
  }

  async function exportPackage() {
    if (state.activeRecording) return toast('Arrêtez l’enregistrement avant de sauvegarder le fichier.');
    if (!state.profile) return toast('Enregistrez d’abord votre profil enquêteur.');
    const hasContent = state.exchanges.some(x => x.question.trim() || x.answer.trim());
    if (!hasContent) return toast('Ajoutez au moins une question ou une réponse.');
    $('#exportBtn').disabled = true;
    $('#exportStatus').textContent = 'Préparation du fichier et des audios…';
    try {
      const questions = [];
      for (const exchange of state.exchanges) {
        const item = { question: exchange.question, answer: exchange.answer, signatureAfter: exchange.signatureAfter };
        for (const kind of ['question','answer']) {
          const clipId = exchange[`${kind}ClipId`];
          if (!clipId) continue;
          const blob = await getClip(clipId);
          if (!blob) continue;
          item[`${kind}Audio`] = {
            clipId,
            mimeType: blob.type || exchange[`${kind}MimeType`] || 'audio/wav',
            durationMs: exchange[`${kind}DurationMs`] || 0,
            dataBase64: await blobToBase64(blob),
          };
        }
        questions.push(item);
      }
      const payload = {
        schema: 'mg.assistantpv.audition/1',
        appVersion: APP_VERSION,
        exportedAt: new Date().toISOString(),
        speechLanguage: $('#speechLanguage').value,
        speechMode: { automatic: $('#autoTranscription').checked, preferOffline: $('#localSpeechOnly').checked, localOnly: false },
        investigator: {
          grade: state.profile.grade,
          name: state.profile.name,
          quality: state.profile.quality,
          function: state.profile.function,
          unit: state.profile.unit || '',
        },
        audition: {
          personRole: $('#personRole').value,
          personIdentity: $('#personIdentity').value,
          identityVerification: $('#identityVerification').value,
          place: $('#place').value,
          startDateTime: $('#startDateTime').value,
          endDateTime: $('#endDateTime').value,
          closingFormula: $('#closingFormula').value,
          personSignatureLabel: $('#personSignatureLabel').value,
          verbalisateurLabel: 'LE VERBALISATEUR',
          questions,
        },
      };
      const json = JSON.stringify(payload);
      const blob = new Blob([json], { type: 'application/json' });
      const person = safeFilePart(($('#personIdentity').value.split(/\n/)[0] || 'audition').slice(0,50));
      const fileName = `audition-${person}-${new Date().toISOString().slice(0,10)}.pvaud`;
      let locationText = '';
      if (isNativeAndroid && NativeAudioRecorder?.saveAuditionFile) {
        const dataBase64 = await blobToBase64(blob);
        const saved = await NativeAudioRecorder.saveAuditionFile({ fileName, dataBase64 });
        locationText = saved?.location || saved?.uri || 'Téléchargements/AssistantPV';
      } else {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 3000);
        locationText = 'dossier de téléchargements';
      }
      $('#exportStatus').textContent = `Fichier enregistré • ${fileName} • ${(blob.size/1024/1024).toFixed(1)} Mo • ${questions.length} échange(s) • ${locationText}`;
      toast('Fichier .pvaud enregistré pour le PC.');
      saveDraft();
    } catch (error) {
      console.error(error);
      $('#exportStatus').textContent = 'Échec de l’enregistrement du fichier.';
      toast(error.message || 'Enregistrement du fichier impossible.');
    } finally {
      $('#exportBtn').disabled = false;
    }
  }

  function safeFilePart(v) {
    return String(v || 'audition').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60) || 'audition';
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  async function resetAll() {
    if (state.activeRecording) stopActiveRecording();
    localStorage.removeItem(STORAGE_KEY);
    await clearClips();
    state.exchanges = [];
    ['personIdentity','identityVerification','endDateTime'].forEach(id => $('#'+id).value = '');
    $('#personRole').value = 'Personne entendue';
    $('#place').value = 'au bureau de notre unité';
    $('#closingFormula').value = "Lecture faite par moi de la déclaration ci-dessus, j’y persiste et n’ai rien à y ajouter, à y changer ou à y retrancher et signe.";
    $('#personSignatureLabel').value = 'LE DECLARANT';
    $('#startDateTime').value = toLocalDateTime(new Date());
    if (state.profile) applyProfileToForm(state.profile);
    addExchange();
    saveDraft();
    updateSpeechSupportMessage();
    window.scrollTo({top:0,behavior:'smooth'});
    toast('Nouvelle audition prête. Profil enquêteur conservé.');
  }

  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 3300);
  }

  function openDb() {
    return new Promise((resolve,reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('clips')) req.result.createObjectStore('clips'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function putClip(id, blob) {
    const db = await openDb();
    return new Promise((resolve,reject) => {
      const tx = db.transaction('clips','readwrite'); tx.objectStore('clips').put(blob,id);
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }
  async function getClip(id) {
    const db = await openDb();
    return new Promise((resolve,reject) => {
      const req = db.transaction('clips','readonly').objectStore('clips').get(id);
      req.onsuccess = () => { db.close(); resolve(req.result || null); }; req.onerror = () => { db.close(); reject(req.error); };
    });
  }
  async function deleteClip(id) {
    const db = await openDb();
    return new Promise((resolve,reject) => {
      const tx = db.transaction('clips','readwrite'); tx.objectStore('clips').delete(id);
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }
  async function clearClips() {
    const db = await openDb();
    return new Promise((resolve,reject) => {
      const tx = db.transaction('clips','readwrite'); tx.objectStore('clips').clear();
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }
})();
