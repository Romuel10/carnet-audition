(() => {
  const APP_VERSION = '3.1.0-beta.3';
  const STORAGE_KEY = 'assistant-pv-carnet-draft-v1';
  const PROFILE_KEY = 'assistant-pv-carnet-investigator-profile-v1';
  const AI_SETTINGS_KEY = 'assistant-pv-carnet-ai-settings-v1';
  const DEFAULT_DICTIONARY = `gendarmerie
brigade
OPJ
APJ
procès-verbal
audition
plainte
victime
témoin
suspect
personne entendue
perquisition
garde à vue
fokontany
kaominina
distrika
faritra
zandary
fanontaniana
valiny
fanambarana
porofo
vavolombelona
mpitory
voampanga
Madagasikara`;
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
        readAudioFile: call('readAudioFile'),
        deleteAudioFile: call('deleteAudioFile'),
        saveAuditionFile: call('saveAuditionFile'),
      };
    }
    return null;
  }

  function resolveNativeWhisper() {
    if (!isNativeAndroid || !CapacitorRuntime) return null;
    const injected = CapacitorRuntime.Plugins?.NativeWhisper;
    if (injected) return injected;
    if (typeof CapacitorRuntime.registerPlugin === 'function') {
      try { return CapacitorRuntime.registerPlugin('NativeWhisper'); } catch (error) { console.warn(error); }
    }
    if (typeof CapacitorRuntime.nativePromise === 'function') {
      const call = method => (options = {}) => CapacitorRuntime.nativePromise('NativeWhisper', method, options);
      return { diagnostics: call('diagnostics'), modelStatus: call('modelStatus'), downloadModel: call('downloadModel'), deleteModel: call('deleteModel'), transcribe: call('transcribe') };
    }
    return null;
  }

  const NativeAudioRecorder = resolveNativeAudioRecorder();
  const NativeWhisper = resolveNativeWhisper();
  const state = { exchanges: [], activeRecording: null, stream: null, saveTimer: null, profile: null, whisperPoll: null };
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
    initAiSettings();
    if (!state.exchanges.length) addExchange(); else renderExchanges();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
    document.addEventListener('input', scheduleSave);
    document.addEventListener('change', scheduleSave);
    updateSpeechSupportMessage();
    refreshWhisperStatus().catch(() => {});
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
    $('#downloadWhisperBtn')?.addEventListener('click', downloadWhisperModel);
    $('#deleteWhisperBtn')?.addEventListener('click', deleteWhisperModel);
    $('#whisperModel')?.addEventListener('change', () => refreshWhisperStatus().catch(() => {}));
    $('#speechEngine')?.addEventListener('change', applySpeechEnginePreset);
  }

  function initAiSettings() {
    let cfg = null;
    try { cfg = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || 'null'); } catch (_) { cfg = null; }
    const migrated = Number(cfg?.settingsVersion || 0) < 3;
    if (!$('#speechDictionary').value.trim()) $('#speechDictionary').value = cfg?.dictionary || DEFAULT_DICTIONARY;
    if (cfg?.engine && $('#speechEngine')) $('#speechEngine').value = cfg.engine;
    if (cfg?.model && $('#whisperModel')) $('#whisperModel').value = cfg.model;
    // Beta.3 privilégie la réactivité : Whisper n'est plus lancé automatiquement après chaque arrêt.
    $('#aiReviewAfterStop').checked = migrated ? false : Boolean(cfg?.aiReviewAfterStop);
    if (cfg?.keepLiveAlternative !== undefined) $('#keepLiveAlternative').checked = Boolean(cfg.keepLiveAlternative);
    if (cfg?.learnFromCorrections !== undefined) $('#learnFromCorrections').checked = Boolean(cfg.learnFromCorrections);
    if (migrated) persistAiSettings();
    ['speechEngine','whisperModel','speechDictionary','aiReviewAfterStop','keepLiveAlternative','learnFromCorrections'].forEach(id => $(`#${id}`)?.addEventListener('change', persistAiSettings));
    $('#speechDictionary')?.addEventListener('input', persistAiSettings);
  }

  function persistAiSettings() {
    const next = {
      settingsVersion: 3,
      engine: $('#speechEngine')?.value || 'smart',
      model: $('#whisperModel')?.value || 'base-q5_1',
      dictionary: $('#speechDictionary')?.value || DEFAULT_DICTIONARY,
      aiReviewAfterStop: $('#aiReviewAfterStop')?.checked !== false,
      keepLiveAlternative: $('#keepLiveAlternative')?.checked !== false,
      learnFromCorrections: $('#learnFromCorrections')?.checked !== false,
    };
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(next));
  }

  function applySpeechEnginePreset() {
    const mode = $('#speechEngine').value;
    if (mode === 'smart') {
      $('#autoTranscription').checked = true;
      $('#localSpeechOnly').checked = false;
      $('#aiReviewAfterStop').checked = false;
    } else if (mode === 'live') {
      $('#autoTranscription').checked = true;
      $('#localSpeechOnly').checked = false;
      $('#aiReviewAfterStop').checked = false;
    } else if (mode === 'offline') {
      $('#autoTranscription').checked = false;
      $('#localSpeechOnly').checked = true;
      $('#aiReviewAfterStop').checked = true;
    }
    scheduleSave();
  }

  function buildBiasingText() {
    const lines = [$('#speechDictionary')?.value || ''];
    if (state.profile) lines.push(state.profile.grade || '', state.profile.name || '', state.profile.unit || '');
    lines.push($('#place')?.value || '');
    const identityFirstLine = ($('#personIdentity')?.value || '').split(/\n/)[0];
    if (identityFirstLine) lines.push(identityFirstLine);
    return lines.join('\n').split(/\n+/).map(x => x.trim()).filter(Boolean).slice(0, 120).join('\n');
  }

  function buildWhisperPrompt() {
    const words = buildBiasingText().split(/\n+/).filter(Boolean).slice(0, 80);
    return `Audition de gendarmerie à Madagascar. Langue principale malagasy, avec éventuellement des termes français. Vocabulaire attendu : ${words.join(', ')}`.slice(0, 1100);
  }

  async function refreshWhisperStatus() {
    const label = $('#whisperModelStatus');
    const details = $('#whisperModelDetails');
    const bar = $('#whisperProgress');
    if (!label || !details || !bar) return;
    if (!isNativeAndroid || !NativeWhisper) {
      label.textContent = 'Whisper local disponible uniquement dans l’APK Android';
      details.textContent = 'La version navigateur garde la transcription du moteur du téléphone.';
      bar.style.width = '0%';
      return;
    }
    const modelId = $('#whisperModel').value || 'base-q5_1';
    try {
      const st = await NativeWhisper.modelStatus({ modelId });
      if (st.downloading) {
        label.textContent = `Téléchargement du modèle IA… ${Number(st.progress || 0)} %`;
        details.textContent = modelId === 'small-q5_1' ? 'Modèle Small Q5 (~181 MiB)' : 'Modèle Base Q5 (~57 MiB)';
        bar.style.width = `${Math.max(2, Number(st.progress || 0))}%`;
      } else if (st.installed) {
        label.textContent = 'Modèle IA local prêt ✓';
        details.textContent = `${modelId} • ${(Number(st.sizeBytes || 0)/1024/1024).toFixed(1)} Mo • transcription hors ligne`;
        bar.style.width = '100%';
      } else {
        label.textContent = 'Modèle IA local non installé';
        details.textContent = modelId === 'small-q5_1' ? 'Small Q5 : plus précis, plus lourd (~181 MiB).' : 'Base Q5 : recommandé pour votre téléphone (~57 MiB).';
        bar.style.width = '0%';
      }
      $('#deleteWhisperBtn').disabled = !st.installed;
    } catch (error) {
      label.textContent = 'Diagnostic Whisper impossible';
      details.textContent = error?.message || String(error);
      bar.style.width = '0%';
    }
  }

  async function downloadWhisperModel() {
    if (!NativeWhisper) return toast('Moteur Whisper natif indisponible dans cet APK.');
    const modelId = $('#whisperModel').value || 'base-q5_1';
    const btn = $('#downloadWhisperBtn');
    btn.disabled = true;
    clearInterval(state.whisperPoll);
    state.whisperPoll = setInterval(() => refreshWhisperStatus().catch(() => {}), 700);
    try {
      toast('Téléchargement du modèle IA démarré. Gardez l’application ouverte.');
      await NativeWhisper.downloadModel({ modelId });
      toast('Modèle IA local installé.');
    } catch (error) {
      toast(error?.message || 'Téléchargement du modèle impossible.');
    } finally {
      clearInterval(state.whisperPoll);
      state.whisperPoll = null;
      btn.disabled = false;
      await refreshWhisperStatus();
    }
  }

  async function deleteWhisperModel() {
    if (!NativeWhisper) return;
    if (!confirm('Supprimer le modèle IA local de ce téléphone ?')) return;
    const modelId = $('#whisperModel').value || 'base-q5_1';
    try {
      await NativeWhisper.deleteModel({ modelId });
      toast('Modèle IA supprimé.');
      await refreshWhisperStatus();
    } catch (error) { toast(error?.message || 'Suppression impossible.'); }
  }

  function learnCorrectionWords(correctedText, systemText) {
    if (!$('#learnFromCorrections')?.checked) return 0;
    const corrected = String(correctedText || '').trim();
    const system = String(systemText || '').trim();
    if (!corrected || !system || corrected === system) return 0;
    const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const tokenRe = /[A-Za-zÀ-ÖØ-öø-ÿ'’\-]{3,}/g;
    const known = new Set((system.match(tokenRe) || []).map(normalize));
    const dictionaryLines = ($('#speechDictionary')?.value || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
    const dictNorm = new Set(dictionaryLines.map(normalize));
    const additions = [];
    for (const word of (corrected.match(tokenRe) || [])) {
      const n = normalize(word);
      if (!n || known.has(n) || dictNorm.has(n) || additions.some(x => normalize(x) === n)) continue;
      additions.push(word.replace(/’/g, "'"));
      if (additions.length >= 8) break;
    }
    if (!additions.length) return 0;
    $('#speechDictionary').value = [...dictionaryLines, ...additions].join('\n');
    persistAiSettings();
    return additions.length;
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
      questionAudioPath: overrides.questionAudioPath || '', answerAudioPath: overrides.answerAudioPath || '',
      questionLiveTranscript: overrides.questionLiveTranscript || '', answerLiveTranscript: overrides.answerLiveTranscript || '',
      questionAiTranscript: overrides.questionAiTranscript || '', answerAiTranscript: overrides.answerAiTranscript || '',
      questionAiModel: overrides.questionAiModel || '', answerAiModel: overrides.answerAiModel || '',
      questionAiElapsedMs: Number(overrides.questionAiElapsedMs || 0), answerAiElapsedMs: Number(overrides.answerAiElapsedMs || 0),
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
    const qText = $('.question-text', card);
    const aText = $('.answer-text', card);
    qText.addEventListener('input', e => { exchange.question = e.target.value; scheduleSave(); });
    aText.addEventListener('input', e => { exchange.answer = e.target.value; scheduleSave(); });
    qText.addEventListener('blur', () => {
      const learned = learnCorrectionWords(qText.value, exchange.questionAiTranscript || exchange.questionLiveTranscript || '');
      if (learned) toast(`${learned} mot(s) corrigé(s) ajouté(s) au dictionnaire local.`);
    });
    aText.addEventListener('blur', () => {
      const learned = learnCorrectionWords(aText.value, exchange.answerAiTranscript || exchange.answerLiveTranscript || '');
      if (learned) toast(`${learned} mot(s) corrigé(s) ajouté(s) au dictionnaire local.`);
    });
    $('.signature-after', card).addEventListener('change', e => { exchange.signatureAfter = e.target.checked; scheduleSave(); });
    $('.question-record', card).addEventListener('click', () => toggleRecording(exchange, 'question', card));
    $('.answer-record', card).addEventListener('click', () => toggleRecording(exchange, 'answer', card));
    $('.remove-exchange', card).addEventListener('click', async () => {
      if (state.activeRecording) return toast('Arrêtez d’abord l’enregistrement en cours.');
      if (exchange.questionClipId) await deleteClip(exchange.questionClipId);
      if (exchange.answerClipId) await deleteClip(exchange.answerClipId);
      if (exchange.questionAudioPath && NativeAudioRecorder?.deleteAudioFile) await NativeAudioRecorder.deleteAudioFile({ path: exchange.questionAudioPath }).catch(() => {});
      if (exchange.answerAudioPath && NativeAudioRecorder?.deleteAudioFile) await NativeAudioRecorder.deleteAudioFile({ path: exchange.answerAudioPath }).catch(() => {});
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
    if (isNativeAndroid) throw new Error('Pont audio natif indisponible. Réinstallez la v3.1 beta.3 puis relancez l’application.');
    return startWebRecording(exchange, kind, card);
  }

  async function startNativeRecording(exchange, kind, card) {
    const button = $(`.${kind}-record`, card);
    const status = $(`.${kind}-status`, card);
    const engineMode = $('#speechEngine')?.value || 'smart';
    const transcribe = $('#autoTranscription').checked && engineMode !== 'offline';
    const language = $('#speechLanguage').value || 'mg-MG';
    const preferOffline = $('#localSpeechOnly').checked;
    const baseText = (kind === 'question' ? exchange.question : exchange.answer).trim();
    status.textContent = transcribe ? 'Ouverture du micro + transcription…' : 'Ouverture du microphone…';
    const started = await NativeAudioRecorder.startRecording({ language, transcribe, preferOffline, biasingText: buildBiasingText() });
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
    if (!finalPass && s === 'listening') {
      const confidence = Number(data.confidence ?? -1);
      const confText = confidence >= 0 ? ` • confiance ${Math.round(confidence*100)}%` : '';
      status.textContent = text ? `Audio + texte en direct…${confText}` : 'Audio en cours • écoute de la parole…';
    }
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
      const audioPath = String(data.path || '');
      if (!audioPath) throw new Error('Le fichier audio n’a pas été créé.');
      const mimeType = data.mimeType || 'audio/wav';
      const durationMs = Number(data.msDuration || (Date.now() - active.startedAt) || 0);
      const oldClip = exchange[`${kind}ClipId`];
      if (oldClip) await deleteClip(oldClip);
      exchange[`${kind}ClipId`] = '';
      const oldPath = exchange[`${kind}AudioPath`];
      if (oldPath && oldPath !== audioPath && NativeAudioRecorder?.deleteAudioFile) await NativeAudioRecorder.deleteAudioFile({ path: oldPath }).catch(() => {});
      exchange[`${kind}AudioPath`] = audioPath;
      exchange[`${kind}DurationMs`] = durationMs;
      exchange[`${kind}MimeType`] = mimeType;
      const player = $(`.${kind}-player`, card);
      player.src = CapacitorRuntime?.convertFileSrc ? CapacitorRuntime.convertFileSrc(audioPath) : audioPath;
      player.hidden = false;
      try { await pollNativeTranscript(active, true); } catch (_) {}
      const textarea = $(`.${kind}-text`, card);
      const liveText = textarea.value.trim();
      exchange[`${kind}LiveTranscript`] = liveText;
      status.textContent = liveText ? `Audio + texte conservés • ${formatDuration(durationMs)}` : `Audio conservé • ${formatDuration(durationMs)} • texte direct indisponible`;
      saveDraft();
      await maybeReviewWithWhisper({ active, exchange, kind, card, status, audioPath, durationMs, liveText });
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

  async function maybeReviewWithWhisper({ active, exchange, kind, card, status, audioPath, durationMs, liveText }) {
    const mode = $('#speechEngine')?.value || 'smart';
    if (!$('#aiReviewAfterStop')?.checked || mode === 'live' || !isNativeAndroid || !NativeWhisper || !audioPath) return;
    const modelId = $('#whisperModel')?.value || 'base-q5_1';
    let modelState = null;
    try { modelState = await NativeWhisper.modelStatus({ modelId }); } catch (_) {}
    if (!modelState?.installed) {
      status.textContent = `Audio + texte conservés • ${formatDuration(durationMs)} • modèle IA non installé`;
      return;
    }
    status.classList.add('ai-processing');
    status.textContent = `Audio conservé • révision IA Malagasy en cours…`;
    try {
      const language = ($('#speechLanguage').value || 'mg-MG').toLowerCase().startsWith('fr') ? 'fr' : 'mg';
      const ai = await NativeWhisper.transcribe({ audioPath, modelId, language, prompt: buildWhisperPrompt() });
      const aiText = String(ai?.text || '').trim();
      if (!aiText) throw new Error('Whisper n’a produit aucun texte.');
      exchange[`${kind}AiTranscript`] = aiText;
      exchange[`${kind}AiModel`] = modelId;
      exchange[`${kind}AiElapsedMs`] = Number(ai?.elapsedMs || 0);
      const finalText = [active.baseText, aiText].filter(Boolean).join(active.baseText ? ' ' : '').trim();
      const textarea = $(`.${kind}-text`, card);
      textarea.value = finalText;
      if (kind === 'question') exchange.question = finalText; else exchange.answer = finalText;
      status.textContent = `Audio + texte IA conservés • ${formatDuration(durationMs)} • IA ${(Number(ai?.elapsedMs || 0)/1000).toFixed(1)} s`;
      saveDraft();
    } catch (error) {
      console.warn('Whisper review failed', error);
      status.textContent = `Audio + texte direct conservés • ${formatDuration(durationMs)} • révision IA indisponible`;
      if (!liveText) toast(error?.message || 'Révision IA indisponible.');
    } finally {
      status.classList.remove('ai-processing');
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
      el.textContent = 'ERREUR : pont audio natif indisponible. Vérifiez que la v3.1 beta.3 est bien installée.';
      return;
    }
    try {
      const d = await NativeAudioRecorder.diagnostics();
      const speech = d.liveTranscriptionSupported ? 'transcription live prête' : 'transcription live selon moteur Android';
      let whisper = 'Whisper non vérifié';
      try {
        if (NativeWhisper) {
          const ws = await NativeWhisper.modelStatus({ modelId: $('#whisperModel')?.value || 'base-q5_1' });
          whisper = ws.installed ? 'Whisper local prêt' : 'Whisper à télécharger';
        }
      } catch (_) {}
      el.textContent = `Audio natif prêt • ${speech} • ${whisper} • Android ${d.sdk ?? '?'} • ${d.manufacturer ?? ''} ${d.model ?? ''} • micro: ${d.permission ?? 'à demander'} • v${APP_VERSION}`;
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
    const card = document.querySelector(`[data-exchange-id="${CSS.escape(exchange.id)}"]`);
    if (!card) return;
    const audioPath = exchange[`${kind}AudioPath`];
    const player = $(`.${kind}-player`, card);
    if (audioPath && isNativeAndroid) {
      player.src = CapacitorRuntime?.convertFileSrc ? CapacitorRuntime.convertFileSrc(audioPath) : audioPath;
      player.hidden = false;
      $(`.${kind}-status`, card).textContent = `Audio conservé • ${formatDuration(exchange[`${kind}DurationMs`])}`;
      return;
    }
    const clipId = exchange[`${kind}ClipId`];
    if (!clipId) return;
    const blob = await getClip(clipId);
    if (!blob) return;
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
      version: 3,
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
      speechEngine: $('#speechEngine')?.value || 'smart',
      whisperModel: $('#whisperModel')?.value || 'base-q5_1',
      speechDictionary: $('#speechDictionary')?.value || DEFAULT_DICTIONARY,
      aiReviewAfterStop: $('#aiReviewAfterStop')?.checked !== false,
      keepLiveAlternative: $('#keepLiveAlternative')?.checked !== false,
      learnFromCorrections: $('#learnFromCorrections')?.checked !== false,
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
    const legacyDraft = Number(d.version || 0) < 3;
    if (d.autoTranscription !== undefined) $('#autoTranscription').checked = Boolean(d.autoTranscription);
    if (legacyDraft) $('#localSpeechOnly').checked = false;
    else if (d.localSpeechOnly !== undefined) $('#localSpeechOnly').checked = Boolean(d.localSpeechOnly);
    if (d.speechEngine && $('#speechEngine')) $('#speechEngine').value = d.speechEngine;
    if (d.whisperModel && $('#whisperModel')) $('#whisperModel').value = d.whisperModel;
    if (d.speechDictionary !== undefined && $('#speechDictionary')) $('#speechDictionary').value = d.speechDictionary;
    if (legacyDraft) $('#aiReviewAfterStop').checked = false;
    else if (d.aiReviewAfterStop !== undefined && $('#aiReviewAfterStop')) $('#aiReviewAfterStop').checked = Boolean(d.aiReviewAfterStop);
    if (d.keepLiveAlternative !== undefined && $('#keepLiveAlternative')) $('#keepLiveAlternative').checked = Boolean(d.keepLiveAlternative);
    if (d.learnFromCorrections !== undefined && $('#learnFromCorrections')) $('#learnFromCorrections').checked = Boolean(d.learnFromCorrections);
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
        const keepLive = $('#keepLiveAlternative')?.checked !== false;
        const item = { question: exchange.question, answer: exchange.answer, signatureAfter: exchange.signatureAfter, transcription: { question: { live: keepLive ? (exchange.questionLiveTranscript || '') : '', ai: exchange.questionAiTranscript || '', model: exchange.questionAiModel || '', elapsedMs: exchange.questionAiElapsedMs || 0 }, answer: { live: keepLive ? (exchange.answerLiveTranscript || '') : '', ai: exchange.answerAiTranscript || '', model: exchange.answerAiModel || '', elapsedMs: exchange.answerAiElapsedMs || 0 } } };
        for (const kind of ['question','answer']) {
          const audioPath = exchange[`${kind}AudioPath`];
          if (audioPath && isNativeAndroid && NativeAudioRecorder?.readAudioFile) {
            const audio = await NativeAudioRecorder.readAudioFile({ path: audioPath });
            if (audio?.dataBase64) {
              item[`${kind}Audio`] = {
                clipId: `${exchange.id}-${kind}`,
                mimeType: audio.mimeType || exchange[`${kind}MimeType`] || 'audio/wav',
                durationMs: exchange[`${kind}DurationMs`] || 0,
                dataBase64: audio.dataBase64,
              };
              continue;
            }
          }
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
        speechMode: { automatic: $('#autoTranscription').checked, preferOffline: $('#localSpeechOnly').checked, localOnly: $('#speechEngine')?.value === 'offline', engine: $('#speechEngine')?.value || 'smart', whisperModel: $('#whisperModel')?.value || '', whisperReview: $('#aiReviewAfterStop')?.checked !== false, learnedCorrections: $('#learnFromCorrections')?.checked !== false, vocabulary: buildBiasingText().split(/\n+/).filter(Boolean) },
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
    for (const exchange of state.exchanges) {
      for (const kind of ['question','answer']) {
        const path = exchange[`${kind}AudioPath`];
        if (path && NativeAudioRecorder?.deleteAudioFile) await NativeAudioRecorder.deleteAudioFile({ path }).catch(() => {});
      }
    }
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
