(() => {
  const APP_VERSION = '3.2.2-beta.1';
  const STORAGE_KEY = 'assistant-pv-carnet-draft-v1';
  const PROFILE_KEY = 'assistant-pv-carnet-investigator-profile-v1';
  const AI_SETTINGS_KEY = 'assistant-pv-carnet-ai-settings-v1';
  const LEARNED_CORRECTIONS_KEY = 'assistant-pv-carnet-learned-corrections-v1';
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
        drainPcmChunks: call('drainPcmChunks'),
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
  const state = { exchanges: [], activeRecording: null, stream: null, saveTimer: null, profile: null, whisperPoll: null, lastCloudCheck: null, learnedCorrections: loadLearnedCorrections(), reviewJobs: new Map() };
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
    updateLearnedCorrectionsCount();
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
    $('#clearLearnedCorrectionsBtn')?.addEventListener('click', clearLearnedCorrections);
    $('#whisperModel')?.addEventListener('change', () => refreshWhisperStatus().catch(() => {}));
    $('#testCloudBtn')?.addEventListener('click', testCloudConnection);
    $$('input[name="speechModeChoice"]').forEach(input => input.addEventListener('change', () => {
      syncSpeechModeUi();
      persistAiSettings();
      scheduleSave();
    }));
  }

  function getSpeechMode() {
    return $('input[name="speechModeChoice"]:checked')?.value || 'android';
  }

  function setSpeechMode(mode) {
    const safe = ['android','private'].includes(mode) ? mode : 'android';
    const input = $(`input[name="speechModeChoice"][value="${safe}"]`);
    if (input) input.checked = true;
    syncSpeechModeUi();
  }

  function syncSpeechModeUi() {
    const mode = getSpeechMode();
    const cloudSetup = $('#cloudSetup');
    if (cloudSetup) cloudSetup.hidden = true;
    if (mode === 'android') {
      $('#speechEngine').value = 'smart';
      $('#autoTranscription').checked = true;
      $('#localSpeechOnly').checked = false;
      updateCloudStatus('Gratuit', 'is-online');
    } else {
      $('#speechEngine').value = 'offline';
      $('#autoTranscription').checked = false;
      $('#localSpeechOnly').checked = true;
      $('#aiReviewAfterStop').checked = true;
      updateCloudStatus('Local', 'is-neutral');
    }
  }

  function initAiSettings() {
    let cfg = null;
    try { cfg = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || 'null'); } catch (_) { cfg = null; }
    const migrated = Number(cfg?.settingsVersion || 0) < 6;
    if (!$('#speechDictionary').value.trim()) $('#speechDictionary').value = cfg?.dictionary || DEFAULT_DICTIONARY;
    if (cfg?.model && $('#whisperModel')) $('#whisperModel').value = cfg.model;
    $('#aiReviewAfterStop').checked = migrated ? true : cfg?.aiReviewAfterStop !== false;
    if (cfg?.keepLiveAlternative !== undefined) $('#keepLiveAlternative').checked = Boolean(cfg.keepLiveAlternative);
    if (cfg?.learnFromCorrections !== undefined) $('#learnFromCorrections').checked = Boolean(cfg.learnFromCorrections);
    if ($('#onlineRelayUrl')) $('#onlineRelayUrl').value = cfg?.relayUrl || '';
    if ($('#onlineRelayToken')) $('#onlineRelayToken').value = cfg?.relayToken || '';
    if ($('#microProfile')) $('#microProfile').value = cfg?.microProfile || 'near_field';
    const oldEngine = cfg?.engine || $('#speechEngine')?.value || 'smart';
    let preferredMode = cfg?.speechMode || (oldEngine === 'offline' ? 'private' : 'android');
    if (preferredMode === 'cloud') preferredMode = 'android';
    setSpeechMode(migrated ? 'android' : preferredMode);
    if (migrated) persistAiSettings();
    ['whisperModel','speechDictionary','aiReviewAfterStop','keepLiveAlternative','learnFromCorrections','onlineRelayUrl','onlineRelayToken','microProfile','autoTranscription','localSpeechOnly'].forEach(id => {
      $(`#${id}`)?.addEventListener('change', () => { persistAiSettings(); });
    });
    $('#speechDictionary')?.addEventListener('input', persistAiSettings);
    $('#onlineRelayUrl')?.addEventListener('input', () => { persistAiSettings(); updateCloudStatus(cloudConfigured() ? 'Prêt à tester' : 'À configurer', 'is-neutral'); });
    $('#onlineRelayToken')?.addEventListener('input', persistAiSettings);
  }

  function persistAiSettings() {
    const next = {
      settingsVersion: 6,
      speechMode: getSpeechMode(),
      engine: $('#speechEngine')?.value || 'smart',
      model: $('#whisperModel')?.value || 'base-q5_1',
      dictionary: $('#speechDictionary')?.value || DEFAULT_DICTIONARY,
      aiReviewAfterStop: $('#aiReviewAfterStop')?.checked === true,
      keepLiveAlternative: $('#keepLiveAlternative')?.checked !== false,
      learnFromCorrections: $('#learnFromCorrections')?.checked !== false,
      relayUrl: $('#onlineRelayUrl')?.value?.trim() || '',
      relayToken: $('#onlineRelayToken')?.value || '',
      microProfile: $('#microProfile')?.value || 'near_field',
    };
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(next));
  }

  function normalizeRelayUrl(value) {
    let url = String(value || '').trim();
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, 'ws');
    if (!/^wss?:\/\//i.test(url)) url = `wss://${url}`;
    return url;
  }

  function cloudConfigured() {
    return false;
  }

  function updateCloudStatus(text, className = 'is-neutral') {
    const el = $('#cloudStatus');
    if (!el) return;
    el.textContent = text;
    el.className = `connection-pill ${className}`;
  }

  function buildCloudPrompt() {
    const words = ($('#speechDictionary')?.value || '').split(/\n+/).map(x => x.trim()).filter(Boolean).slice(0, 100);
    const lang = ($('#speechLanguage')?.value || 'mg-MG').startsWith('fr') ? 'français' : 'malagasy de Madagascar';
    return `Transcription fidèle d'une audition de gendarmerie. Langue principale : ${lang}. Conserver les noms propres et les termes juridiques tels qu'ils sont prononcés. Vocabulaire métier fourni par l'utilisateur : ${words.join(', ')}`.slice(0, 1800);
  }

  function buildCloudKeywords() {
    const raw = ($('#speechDictionary')?.value || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const item of raw) {
      const word = item.replace(/[<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
      const key = word.toLocaleLowerCase('fr');
      if (!word || seen.has(key)) continue;
      seen.add(key);
      out.push(word);
      if (out.length >= 80) break;
    }
    return out;
  }

  async function testCloudConnection() {
    if (!cloudConfigured()) return toast('Renseignez d’abord l’adresse du relais sécurisé.');
    const btn = $('#testCloudBtn');
    btn.disabled = true;
    updateCloudStatus('Connexion…', 'is-connecting');
    let ws;
    try {
      await new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; try { ws?.close(); } catch (_) {} reject(new Error('Délai de connexion dépassé')); } }, 6000);
        ws = new WebSocket(normalizeRelayUrl($('#onlineRelayUrl').value));
        ws.onopen = () => ws.send(JSON.stringify({ type: 'ping', token: $('#onlineRelayToken')?.value || '' }));
        ws.onerror = () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('Connexion impossible')); } };
        ws.onmessage = event => {
          let msg = null; try { msg = JSON.parse(event.data); } catch (_) {}
          if (msg?.type === 'pong' || msg?.type === 'ready') {
            if (!done) { done = true; clearTimeout(timer); resolve(); }
          } else if (msg?.type === 'error') {
            if (!done) { done = true; clearTimeout(timer); reject(new Error(msg.message || 'Relais refusé')); }
          }
        };
      });
      state.lastCloudCheck = Date.now();
      updateCloudStatus('Connexion sécurisée', 'is-online');
      toast('Service de transcription en ligne accessible.');
    } catch (error) {
      updateCloudStatus('Connexion impossible', 'is-error');
      toast(error?.message || 'Service en ligne indisponible.');
    } finally {
      try { ws?.close(); } catch (_) {}
      btn.disabled = false;
    }
  }

  function buildBiasingText() {
    const lines = [$('#speechDictionary')?.value || ''];
    if (state.profile) lines.push(state.profile.grade || '', state.profile.name || '', state.profile.unit || '');
    lines.push(...Object.values(state.learnedCorrections || {}).map(rule => rule?.replacement || '').filter(Boolean));
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
      label.textContent = 'Modèle local disponible uniquement dans l’APK Android';
      details.textContent = 'La version navigateur utilise la dictée disponible sur l’appareil.';
      bar.style.width = '0%';
      return;
    }
    const modelId = $('#whisperModel').value || 'base-q5_1';
    try {
      const st = await NativeWhisper.modelStatus({ modelId });
      if (st.downloading) {
        label.textContent = `Téléchargement du modèle local… ${Number(st.progress || 0)} %`;
        details.textContent = modelId === 'small-q5_1' ? 'Modèle Small Q5 (~181 MiB)' : 'Modèle Base Q5 (~57 MiB)';
        bar.style.width = `${Math.max(2, Number(st.progress || 0))}%`;
      } else if (st.installed) {
        label.textContent = 'Modèle local prêt';
        details.textContent = `${modelId} • ${(Number(st.sizeBytes || 0)/1024/1024).toFixed(1)} Mo • contrôle local prêt après chaque arrêt`;
        bar.style.width = '100%';
      } else {
        label.textContent = 'Modèle local non installé';
        details.textContent = modelId === 'small-q5_1' ? 'Small Q5 : plus précis, plus lourd (~181 MiB).' : 'Base Q5 : recommandé pour votre téléphone (~57 MiB).';
        bar.style.width = '0%';
      }
      $('#deleteWhisperBtn').disabled = !st.installed;
    } catch (error) {
      label.textContent = 'Diagnostic du modèle local impossible';
      details.textContent = error?.message || String(error);
      bar.style.width = '0%';
    }
  }

  async function downloadWhisperModel() {
    if (!NativeWhisper) return toast('Moteur local indisponible dans cet APK.');
    const modelId = $('#whisperModel').value || 'base-q5_1';
    const btn = $('#downloadWhisperBtn');
    btn.disabled = true;
    clearInterval(state.whisperPoll);
    state.whisperPoll = setInterval(() => refreshWhisperStatus().catch(() => {}), 700);
    try {
      toast('Téléchargement du modèle local démarré. Gardez l’application ouverte.');
      await NativeWhisper.downloadModel({ modelId });
      if ($('#aiReviewAfterStop')) $('#aiReviewAfterStop').checked = true;
      persistAiSettings();
      toast('Modèle local installé. Le contrôle automatique est activé.');
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
    if (!confirm('Supprimer le modèle local de ce téléphone ?')) return;
    const modelId = $('#whisperModel').value || 'base-q5_1';
    try {
      await NativeWhisper.deleteModel({ modelId });
      toast('Modèle local supprimé.');
      await refreshWhisperStatus();
    } catch (error) { toast(error?.message || 'Suppression impossible.'); }
  }

  function loadLearnedCorrections() {
    try {
      const raw = JSON.parse(localStorage.getItem(LEARNED_CORRECTIONS_KEY) || '{}');
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (_) { return {}; }
  }

  function saveLearnedCorrections() {
    const entries = Object.entries(state.learnedCorrections || {})
      .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
      .slice(0, 240);
    state.learnedCorrections = Object.fromEntries(entries);
    localStorage.setItem(LEARNED_CORRECTIONS_KEY, JSON.stringify(state.learnedCorrections));
    updateLearnedCorrectionsCount();
  }

  function updateLearnedCorrectionsCount() {
    const el = $('#learnedCorrectionsCount');
    if (!el) return;
    const count = Object.keys(state.learnedCorrections || {}).length;
    el.textContent = `${count} ${count > 1 ? 'règles apprises' : 'règle apprise'}`;
  }

  function clearLearnedCorrections() {
    const count = Object.keys(state.learnedCorrections || {}).length;
    if (!count) return toast('Aucune correction apprise pour le moment.');
    if (!confirm(`Réinitialiser les ${count} correction(s) apprises localement ?`)) return;
    state.learnedCorrections = {};
    localStorage.removeItem(LEARNED_CORRECTIONS_KEY);
    updateLearnedCorrectionsCount();
    toast('Mémoire de corrections réinitialisée.');
  }

  function normalizeToken(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr').replace(/[’]/g, "'").replace(/[^a-z0-9'\-]/g, '');
  }

  function levenshteinDistance(a, b) {
    a = normalizeToken(a); b = normalizeToken(b);
    if (!a) return b.length; if (!b) return a.length;
    const prev = Array.from({length: b.length + 1}, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let left = i;
      let diag = i - 1;
      for (let j = 1; j <= b.length; j++) {
        const up = prev[j];
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        const cur = Math.min(up + 1, left + 1, diag + cost);
        diag = up; prev[j] = cur; left = cur;
      }
      prev[0] = i;
    }
    return prev[b.length];
  }

  function tokenSimilarity(a, b) {
    const aa = normalizeToken(a), bb = normalizeToken(b);
    const max = Math.max(aa.length, bb.length);
    return max ? 1 - (levenshteinDistance(aa, bb) / max) : 1;
  }

  function learnCorrectionPairs(correctedText, systemText) {
    if (!$('#learnFromCorrections')?.checked) return 0;
    const corrected = String(correctedText || '').match(/[A-Za-zÀ-ÖØ-öø-ÿ'’\-]+/g) || [];
    const system = String(systemText || '').match(/[A-Za-zÀ-ÖØ-öø-ÿ'’\-]+/g) || [];
    if (!corrected.length || corrected.length !== system.length || corrected.length > 80) return 0;
    const dictionary = new Set((($('#speechDictionary')?.value || '').match(/[A-Za-zÀ-ÖØ-öø-ÿ'’\-]+/g) || []).map(normalizeToken));
    let added = 0;
    for (let i = 0; i < corrected.length; i++) {
      const wrong = system[i], right = corrected[i];
      const wn = normalizeToken(wrong), rn = normalizeToken(right);
      if (!wn || !rn || wn === rn || wn.length < 4 || rn.length < 4) continue;
      const sim = tokenSimilarity(wn, rn);
      const looksImportant = dictionary.has(rn) || /^[A-ZÀ-ÖØ-Ý]/.test(right) || rn.length >= 8;
      if (sim < 0.42 || (!looksImportant && sim < 0.68)) continue;
      const current = state.learnedCorrections[wn];
      state.learnedCorrections[wn] = {
        replacement: right.replace(/’/g, "'"),
        hits: Number(current?.hits || 0) + 1,
        updatedAt: Date.now(),
      };
      added++;
      if (added >= 8) break;
    }
    if (added) saveLearnedCorrections();
    return added;
  }

  function applyLearnedCorrections(text) {
    const value = String(text || '');
    if (!value || !state.learnedCorrections || !Object.keys(state.learnedCorrections).length) return value;
    return value.replace(/[A-Za-zÀ-ÖØ-öø-ÿ'’\-]+/g, word => {
      const rule = state.learnedCorrections[normalizeToken(word)];
      if (!rule?.replacement) return word;
      let replacement = String(rule.replacement);
      if (word === word.toUpperCase()) replacement = replacement.toUpperCase();
      else if (/^[A-ZÀ-ÖØ-Ý]/.test(word)) replacement = replacement.charAt(0).toUpperCase() + replacement.slice(1);
      return replacement;
    });
  }

  function transcriptionQuality(text) {
    const value = String(text || '').trim();
    if (!value) return -10;
    const tokens = value.match(/[A-Za-zÀ-ÖØ-öø-ÿ'’\-]{2,}/g) || [];
    if (!tokens.length) return -5;
    const normalized = tokens.map(normalizeToken).filter(Boolean);
    const unique = new Set(normalized);
    const dictionary = new Set((($('#speechDictionary')?.value || '').match(/[A-Za-zÀ-ÖØ-öø-ÿ'’\-]+/g) || []).map(normalizeToken));
    const dictHits = normalized.filter(t => dictionary.has(t)).length;
    const repetition = normalized.length ? 1 - unique.size / normalized.length : 0;
    const alphaChars = (value.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
    const alphaRatio = alphaChars / Math.max(1, value.length);
    const suspicious = /(thank you|thanks for watching|subscribe|amara\.org|sous[- ]titres|subtitle|musique|\[music\])/i.test(value) ? 1 : 0;
    const mgCommon = new Set(['ny','sy','dia','fa','aho','izy','izany','amin','tamin','ao','eto','tsy','no','ka','ary','raha','izay','misy','rehefa','satria','tena','mba','ianao']);
    const frCommon = new Set(['le','la','les','de','des','du','et','est','je','vous','nous','dans','pour','que','qui','pas','sur','avec','au','une','un']);
    const lang = ($('#speechLanguage')?.value || 'mg-MG').startsWith('fr') ? frCommon : mgCommon;
    const languageHits = normalized.filter(t => lang.has(t)).length;
    return Math.min(2.5,
      Math.log10(1 + normalized.length) * 0.55 +
      Math.min(0.7, dictHits * 0.08) +
      Math.min(0.55, languageHits * 0.045) +
      alphaRatio * 0.35 -
      repetition * 1.1 -
      suspicious * 1.4
    );
  }

  function chooseSmartTranscript(directText, aiText, directConfidence = -1) {
    const direct = String(directText || '').trim();
    const ai = applyLearnedCorrections(String(aiText || '').trim());
    if (!ai) return { choice: 'direct', text: direct, directScore: transcriptionQuality(direct), aiScore: -10, reason: 'empty-ai' };
    if (!direct) return { choice: 'ai', text: ai, directScore: -10, aiScore: transcriptionQuality(ai), reason: 'empty-direct' };
    const ds = transcriptionQuality(direct), as = transcriptionQuality(ai);
    const dw = (direct.match(/\S+/g) || []).length, aw = (ai.match(/\S+/g) || []).length;
    const ratio = aw / Math.max(1, dw);
    const plausibleLength = ratio >= 0.45 && ratio <= 2.4;
    const confidence = Number(directConfidence ?? -1);
    const threshold = confidence >= 0.78 ? 0.34 : confidence >= 0.55 ? 0.22 : confidence >= 0 ? 0.10 : 0.18;
    const aiClearlyBetter = plausibleLength && as >= ds + threshold;
    return { choice: aiClearlyBetter ? 'ai' : 'direct', text: aiClearlyBetter ? ai : direct, directScore: ds, aiScore: as, reason: aiClearlyBetter ? 'quality' : 'keep-direct' };
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
      questionLiveRawTranscript: overrides.questionLiveRawTranscript || '', answerLiveRawTranscript: overrides.answerLiveRawTranscript || '',
      questionAiCandidate: overrides.questionAiCandidate || '', answerAiCandidate: overrides.answerAiCandidate || '',
      questionAiTranscript: overrides.questionAiTranscript || '', answerAiTranscript: overrides.answerAiTranscript || '',
      questionAiModel: overrides.questionAiModel || '', answerAiModel: overrides.answerAiModel || '',
      questionAiElapsedMs: Number(overrides.questionAiElapsedMs || 0), answerAiElapsedMs: Number(overrides.answerAiElapsedMs || 0),
      questionCloudTranscript: overrides.questionCloudTranscript || '', answerCloudTranscript: overrides.answerCloudTranscript || '',
      questionCloudModel: overrides.questionCloudModel || '', answerCloudModel: overrides.answerCloudModel || '',
      questionCloudLatencyMs: Number(overrides.questionCloudLatencyMs || 0), answerCloudLatencyMs: Number(overrides.answerCloudLatencyMs || 0),
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
      const source = String(exchange.questionAiDecision || '').includes('ai') ? (exchange.questionAiTranscript || '') : (exchange.questionLiveTranscript || exchange.questionLiveRawTranscript || exchange.questionAiTranscript || '');
      const learned = learnCorrectionWords(qText.value, source);
      const pairs = learnCorrectionPairs(qText.value, source);
      if (learned || pairs) toast(`${learned + pairs} amélioration(s) mémorisée(s) localement.`);
    });
    aText.addEventListener('blur', () => {
      const source = String(exchange.answerAiDecision || '').includes('ai') ? (exchange.answerAiTranscript || '') : (exchange.answerLiveTranscript || exchange.answerLiveRawTranscript || exchange.answerAiTranscript || '');
      const learned = learnCorrectionWords(aText.value, source);
      const pairs = learnCorrectionPairs(aText.value, source);
      if (learned || pairs) toast(`${learned + pairs} amélioration(s) mémorisée(s) localement.`);
    });
    $('.signature-after', card).addEventListener('change', e => { exchange.signatureAfter = e.target.checked; scheduleSave(); });
    $('.question-record', card).addEventListener('click', () => toggleRecording(exchange, 'question', card));
    $('.answer-record', card).addEventListener('click', () => toggleRecording(exchange, 'answer', card));
    $('.question-review', card)?.addEventListener('click', () => runManualLocalReview(exchange, 'question', card));
    $('.answer-review', card)?.addEventListener('click', () => runManualLocalReview(exchange, 'answer', card));
    $$('.use-review', card).forEach(btn => btn.addEventListener('click', () => useReviewSuggestion(exchange, btn.dataset.kind, card)));
    $$('.dismiss-review', card).forEach(btn => btn.addEventListener('click', () => dismissReviewSuggestion(exchange, btn.dataset.kind, card)));
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
    if (isNativeAndroid) throw new Error('Pont audio natif indisponible. Réinstallez la v3.2.2 gratuite intelligente puis relancez l’application.');
    return startWebRecording(exchange, kind, card);
  }

  async function startNativeRecording(exchange, kind, card) {
    const button = $(`.${kind}-record`, card);
    const status = $(`.${kind}-status`, card);
    const badge = $(`.${kind}-live-badge`, card);
    const mode = getSpeechMode();
    const useCloud = mode === 'cloud' && cloudConfigured();
    const transcribe = $('#autoTranscription').checked && mode !== 'private';
    const language = $('#speechLanguage').value || 'mg-MG';
    const preferOffline = mode === 'android' && $('#localSpeechOnly').checked;
    const baseText = (kind === 'question' ? exchange.question : exchange.answer).trim();
    status.textContent = useCloud ? 'Ouverture du microphone et connexion sécurisée…' : transcribe ? 'Ouverture du microphone et de la dictée…' : 'Ouverture du microphone…';
    const started = await NativeAudioRecorder.startRecording({ language, transcribe, preferOffline, biasingText: buildBiasingText(), streamPcm: useCloud });
    if (started?.value === false) throw new Error('Le microphone n’a pas démarré.');
    button.classList.add('recording');
    $('.record-label', button).textContent = 'Arrêter';
    if (badge) { badge.hidden = !transcribe; badge.textContent = useCloud ? 'Texte provisoire' : 'Dictée en direct'; }
    status.textContent = useCloud ? 'Audio en cours • dictée immédiate • connexion au service en ligne…' : transcribe ? 'Audio et dictée en direct…' : 'Enregistrement audio en cours…';
    const active = {
      exchangeId: exchange.id, kind, native: true, card, startedAt: Date.now(), baseText,
      pollTimer: null, pcmTimer: null, androidText: '', cloudText: '', cloudFinalText: '',
      cloudHasText: false, cloudPending: [], cloudSocket: null, cloudReady: false, cloudStopped: false,
      cloudFinalPromise: null, cloudFinalResolve: null, cloudConnectStartedAt: Date.now()
    };
    state.activeRecording = active;
    if (transcribe && NativeAudioRecorder.getTranscriptionState) {
      active.pollTimer = setInterval(() => pollNativeTranscript(active).catch(() => {}), 220);
      pollNativeTranscript(active).catch(() => {});
    }
    if (useCloud) {
      active.cloudFinalPromise = new Promise(resolve => { active.cloudFinalResolve = resolve; });
      startCloudTranscription(active).catch(error => {
        console.warn('Cloud transcription unavailable', error);
        updateCloudStatus('Secours Android', 'is-error');
        status.textContent = 'Audio en cours • service en ligne indisponible • dictée Android de secours';
      });
      if (NativeAudioRecorder.drainPcmChunks) {
        active.pcmTimer = setInterval(() => drainNativePcm(active).catch(() => {}), 180);
      }
    } else if (mode === 'cloud') {
      updateCloudStatus('À configurer', 'is-neutral');
      status.textContent = 'Audio en cours • relais en ligne non configuré • dictée Android de secours';
    }
  }

  async function startCloudTranscription(active) {
    const url = normalizeRelayUrl($('#onlineRelayUrl')?.value);
    if (!url) throw new Error('Adresse du relais manquante.');
    updateCloudStatus('Connexion…', 'is-connecting');
    const ws = new WebSocket(url);
    active.cloudSocket = ws;
    const connectTimeout = setTimeout(() => {
      if (!active.cloudReady) try { ws.close(); } catch (_) {}
    }, 6500);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'init',
        token: $('#onlineRelayToken')?.value || '',
        language: ($('#speechLanguage')?.value || 'mg-MG').toLowerCase().startsWith('fr') ? 'fr' : 'mg',
        prompt: buildCloudPrompt(),
        keywords: buildCloudKeywords(),
        microProfile: $('#microProfile')?.value || 'near_field',
        appVersion: APP_VERSION,
      }));
    };
    ws.onmessage = event => {
      let msg = null;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      handleCloudMessage(active, msg);
    };
    ws.onerror = () => {
      if (!active.cloudReady) updateCloudStatus('Connexion impossible', 'is-error');
    };
    ws.onclose = () => {
      clearTimeout(connectTimeout);
      if (!active.cloudFinalText && !active.cloudStopped) updateCloudStatus('Secours Android', 'is-error');
    };
  }

  function handleCloudMessage(active, msg) {
    const exchange = state.exchanges.find(x => x.id === active.exchangeId);
    const card = active.card;
    if (!exchange || !card || !msg) return;
    const textarea = $(`.${active.kind}-text`, card);
    const status = $(`.${active.kind}-status`, card);
    const quality = $(`.${active.kind}-cloud-quality`, card);
    const badge = $(`.${active.kind}-live-badge`, card);
    if (msg.type === 'ready') {
      active.cloudReady = true;
      updateCloudStatus('En ligne', 'is-online');
      if (badge) { badge.hidden = false; badge.textContent = 'Transcription en ligne'; }
      for (const chunk of active.cloudPending.splice(0)) sendCloudChunk(active, chunk);
      return;
    }
    if (msg.type === 'partial' || msg.type === 'final' || msg.type === 'refined') {
      const text = String(msg.text || '').trim();
      if (!text) return;
      active.cloudHasText = true;
      active.cloudText = text;
      if (msg.type === 'final' || msg.type === 'refined') active.cloudFinalText = text;
      const value = [active.baseText, text].filter(Boolean).join(active.baseText ? ' ' : '').trim();
      textarea.value = value;
      if (active.kind === 'question') exchange.question = value; else exchange.answer = value;
      exchange[`${active.kind}CloudTranscript`] = text;
      exchange[`${active.kind}CloudModel`] = String(msg.model || 'online-transcription');
      exchange[`${active.kind}CloudLatencyMs`] = Number(msg.latencyMs || 0);
      if (msg.type === 'refined') {
        exchange[`${active.kind}CloudRefinedTranscript`] = text;
        exchange[`${active.kind}CloudRefinedModel`] = String(msg.model || 'gpt-transcribe');
      }
      if (quality) quality.textContent = msg.type === 'partial' ? 'Texte en ligne en direct' : msg.type === 'refined' ? 'Texte haute précision finalisé' : 'Texte temps réel finalisé';
      if (badge) { badge.hidden = false; badge.textContent = msg.type === 'partial' ? 'En direct' : msg.type === 'refined' ? 'Haute précision' : 'Texte final'; }
      status.textContent = msg.type === 'partial'
        ? 'Audio en cours • texte en ligne en direct'
        : msg.type === 'refined'
          ? 'Audio conservé • transcription haute précision finalisée'
          : msg.refinementPending
            ? 'Audio conservé • texte temps réel prêt • amélioration finale en arrière-plan'
            : 'Audio conservé • transcription en ligne finalisée';
      scheduleSave();
      if (msg.type === 'final') {
        updateCloudStatus('En ligne', 'is-online');
        active.cloudFinalResolve?.(text);
        active.cloudFinalResolve = null;
        if (!msg.refinementPending) setTimeout(() => { try { active.cloudSocket?.close(); } catch (_) {} }, 250);
      }
      return;
    }
    if (msg.type === 'status' && (msg.value === 'finalizing' || msg.value === 'finalizing_live')) {
      status.textContent = 'Audio conservé • finalisation du texte temps réel…';
      return;
    }
    if (msg.type === 'status' && msg.value === 'refining') {
      status.textContent = 'Audio conservé • texte temps réel prêt • amélioration haute précision en cours…';
      return;
    }
    if (msg.type === 'refinement_error') {
      if (quality) quality.textContent = 'Texte temps réel conservé';
      status.textContent = 'Audio conservé • texte temps réel conservé • amélioration finale indisponible';
      return;
    }
    if (msg.type === 'done') {
      updateCloudStatus('En ligne', 'is-online');
      setTimeout(() => { try { active.cloudSocket?.close(); } catch (_) {} }, 150);
      return;
    }
    if (msg.type === 'error') {
      const message = String(msg.message || 'service en ligne indisponible');
      if (quality) quality.textContent = 'Secours Android actif';
      status.textContent = `Audio en cours • ${message} • dictée Android de secours`;
      updateCloudStatus('Secours Android', 'is-error');
      active.cloudFinalResolve?.('');
      active.cloudFinalResolve = null;
    }
  }

  async function drainNativePcm(active) {
    if (!NativeAudioRecorder?.drainPcmChunks) return;
    const data = await NativeAudioRecorder.drainPcmChunks();
    const chunks = Array.isArray(data?.chunks) ? data.chunks : [];
    for (const chunk of chunks) {
      if (!chunk) continue;
      if (active.cloudReady && active.cloudSocket?.readyState === WebSocket.OPEN) sendCloudChunk(active, chunk);
      else {
        active.cloudPending.push(chunk);
        if (active.cloudPending.length > 50) active.cloudPending.shift();
      }
    }
  }

  function sendCloudChunk(active, chunk) {
    try {
      if (active.cloudSocket?.readyState === WebSocket.OPEN) active.cloudSocket.send(JSON.stringify({ type: 'audio', audio: chunk }));
    } catch (_) {}
  }

  async function stopCloudTranscription(active) {
    if (!active?.cloudSocket) return '';
    try { await drainNativePcm(active); } catch (_) {}
    active.cloudStopped = true;
    try {
      if (active.cloudSocket.readyState === WebSocket.OPEN) active.cloudSocket.send(JSON.stringify({ type: 'stop' }));
    } catch (_) {}
    if (!active.cloudFinalPromise) return active.cloudFinalText || '';
    return Promise.race([active.cloudFinalPromise, sleep(1200).then(() => active.cloudFinalText || '')]);
  }

  async function pollNativeTranscript(active, finalPass = false) {
    if (!NativeAudioRecorder?.getTranscriptionState) return;
    const data = await NativeAudioRecorder.getTranscriptionState();
    if (!data) return;
    const exchange = state.exchanges.find(x => x.id === active.exchangeId);
    const card = active.card;
    if (!exchange || !card) return;
    const rawText = String(data.text || '').trim();
    const text = applyLearnedCorrections(rawText);
    active.androidRawText = rawText || active.androidRawText || '';
    active.androidText = text || active.androidText;
    const reportedConfidence = Number(data.confidence ?? -1);
    if (reportedConfidence >= 0) active.androidConfidence = reportedConfidence;
    if (text && !active.cloudHasText) {
      const value = [active.baseText, text].filter(Boolean).join(active.baseText ? ' ' : '').trim();
      const textarea = $(`.${active.kind}-text`, card);
      textarea.value = value;
      if (active.kind === 'question') exchange.question = value; else exchange.answer = value;
      scheduleSave();
    }
    const status = $(`.${active.kind}-status`, card);
    const badge = $(`.${active.kind}-live-badge`, card);
    const s = String(data.status || '');
    if (!finalPass && s === 'listening' && !active.cloudHasText) {
      const confidence = Number(data.confidence ?? -1);
      const confText = confidence >= 0 ? ` • confiance ${Math.round(confidence*100)}%` : '';
      status.textContent = text ? `Audio en cours • texte provisoire${confText}` : 'Audio en cours • écoute de la parole…';
      if (badge) { badge.hidden = false; badge.textContent = 'Texte provisoire'; }
    }
    if (!finalPass && s === 'unsupported' && !active.cloudReady) status.textContent = 'Audio en cours • dictée Android indisponible';
    if (!finalPass && s === 'error' && !active.cloudReady) status.textContent = `Audio en cours • dictée Android indisponible${data.errorMessage ? ` (${data.errorMessage})` : ''}`;
  }

  async function stopNativeRecording(active) {
    const { exchangeId, kind, card } = active;
    const exchange = state.exchanges.find(x => x.id === exchangeId);
    const button = $(`.${kind}-record`, card);
    const status = $(`.${kind}-status`, card);
    const badge = $(`.${kind}-live-badge`, card);
    if (active.pollTimer) clearInterval(active.pollTimer);
    if (active.pcmTimer) clearInterval(active.pcmTimer);
    try {
      status.textContent = 'Arrêt de l’enregistrement…';
      const result = await NativeAudioRecorder.stopRecording();
      try { await drainNativePcm(active); } catch (_) {}
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
      exchange[`${kind}LiveRawTranscript`] = active.androidRawText || active.androidText || '';
      exchange[`${kind}LiveTranscript`] = active.androidText || '';
      const cloudFinal = await stopCloudTranscription(active);
      const textarea = $(`.${kind}-text`, card);
      const liveText = textarea.value.trim();
      if (cloudFinal) {
        status.textContent = `Audio + texte en ligne conservés • ${formatDuration(durationMs)}`;
        if (badge) { badge.hidden = false; badge.textContent = 'Texte final'; }
      } else if (active.cloudSocket && !active.cloudFinalText) {
        status.textContent = `Audio conservé • ${formatDuration(durationMs)} • finalisation en ligne en arrière-plan`;
      } else {
        status.textContent = liveText ? `Audio + texte conservés • ${formatDuration(durationMs)}` : `Audio conservé • ${formatDuration(durationMs)} • texte indisponible`;
      }
      const reviewBtn = $(`.${kind}-review`, card);
      if (reviewBtn) reviewBtn.hidden = false;
      saveDraft();
      if ($('#aiReviewAfterStop')?.checked) {
        setTimeout(() => maybeReviewWithWhisper({ active, exchange, kind, card, status, audioPath, durationMs, liveText, automatic: true }).catch(() => {}), 30);
      }
    } catch (error) {
      console.error(error);
      status.textContent = 'Échec de l’enregistrement.';
      toast(error?.message || 'L’audio n’a pas pu être conservé.');
      try { active.cloudSocket?.close(); } catch (_) {}
    } finally {
      button.classList.remove('recording');
      $('.record-label', button).textContent = kind === 'question' ? 'Enregistrer la question' : 'Enregistrer la réponse';
      state.activeRecording = null;
    }
  }

  async function maybeReviewWithWhisper({ active, exchange, kind, card, status, audioPath, durationMs, liveText, automatic = false }) {
    if (!isNativeAndroid || !NativeWhisper || !audioPath) return false;
    const modelId = $('#whisperModel')?.value || 'base-q5_1';
    let modelState = null;
    try { modelState = await NativeWhisper.modelStatus({ modelId }); } catch (_) {}
    const reviewBtn = $(`.${kind}-review`, card);
    const note = $(`.${kind}-review-note`, card);
    if (!modelState?.installed) {
      if (automatic) {
        if (note) note.textContent = 'Installez le modèle local pour activer le contrôle automatique.';
      } else toast('Installez d’abord le modèle local dans les paramètres avancés.');
      return false;
    }

    const jobKey = `${exchange.id}:${kind}`;
    if (state.reviewJobs.has(jobKey)) return false;
    const reviewToken = uid();
    state.reviewJobs.set(jobKey, reviewToken);
    exchange[`${kind}ReviewToken`] = reviewToken;
    const textarea = $(`.${kind}-text`, card);
    const directTextAtStart = textarea.value.trim();
    const expectedAudioPath = audioPath;
    status.classList.add('ai-processing');
    if (reviewBtn) reviewBtn.disabled = true;
    if (note) note.textContent = 'Vérification locale en arrière-plan…';
    if (!state.activeRecording || state.activeRecording.exchangeId !== exchange.id || state.activeRecording.kind !== kind) {
      status.textContent = `Audio + texte direct conservés • ${formatDuration(durationMs)} • contrôle local en cours`;
    }

    try {
      const language = ($('#speechLanguage').value || 'mg-MG').toLowerCase().startsWith('fr') ? 'fr' : 'mg';
      const ai = await NativeWhisper.transcribe({ audioPath, modelId, language, prompt: buildWhisperPrompt() });
      if (state.reviewJobs.get(jobKey) !== reviewToken || exchange[`${kind}AudioPath`] !== expectedAudioPath || !state.exchanges.includes(exchange) || !card.isConnected) return false;
      const aiTextRaw = String(ai?.text || '').trim();
      const aiText = applyLearnedCorrections(aiTextRaw);
      if (!aiText) throw new Error('Le modèle local n’a produit aucun texte.');
      exchange[`${kind}AiTranscript`] = aiText;
      exchange[`${kind}AiModel`] = modelId;
      exchange[`${kind}AiElapsedMs`] = Number(ai?.elapsedMs || 0);
      const currentText = textarea.value.trim();
      const userEditedSinceStart = currentText !== directTextAtStart;
      const directForComparison = String(active?.androidText || directTextAtStart || '').trim();
      const decision = chooseSmartTranscript(directForComparison, aiText, active?.androidConfidence ?? -1);
      const candidateText = [active?.baseText || '', aiText].filter(Boolean).join(active?.baseText ? ' ' : '').trim();
      exchange[`${kind}AiCandidate`] = candidateText;
      exchange[`${kind}AiDecision`] = decision.choice;
      exchange[`${kind}AiDirectScore`] = decision.directScore;
      exchange[`${kind}AiScore`] = decision.aiScore;

      if (!userEditedSinceStart && decision.choice === 'ai') {
        const finalText = candidateText;
        textarea.value = finalText;
        if (kind === 'question') exchange.question = finalText; else exchange.answer = finalText;
        exchange[`${kind}AiCandidate`] = '';
        hideReviewSuggestion(card, kind);
        status.textContent = `Audio + texte vérifiés localement • ${formatDuration(durationMs)} • ${(Number(ai?.elapsedMs || 0)/1000).toFixed(1)} s`;
        if (note) note.textContent = 'La proposition locale a été retenue automatiquement.';
      } else {
        showReviewSuggestion(card, kind, candidateText);
        status.textContent = `Audio + texte direct conservés • ${formatDuration(durationMs)} • proposition locale disponible`;
        if (note) note.textContent = userEditedSinceStart ? 'Votre correction manuelle a été conservée.' : 'Le texte direct reste prioritaire ; comparez si nécessaire.';
      }
      saveDraft();
      return true;
    } catch (error) {
      console.warn('Whisper review failed', error);
      if (note) note.textContent = 'Contrôle local indisponible pour cet enregistrement.';
      if (!automatic) toast(error?.message || 'Révision locale indisponible.');
      return false;
    } finally {
      if (state.reviewJobs.get(jobKey) === reviewToken) state.reviewJobs.delete(jobKey);
      status.classList.remove('ai-processing');
      if (reviewBtn) reviewBtn.disabled = false;
    }
  }

  async function runManualLocalReview(exchange, kind, card) {
    if (state.activeRecording) return toast('Arrêtez d’abord l’enregistrement en cours.');
    const audioPath = exchange[`${kind}AudioPath`];
    if (!audioPath) return toast('Aucun audio à vérifier pour ce bloc.');
    const status = $(`.${kind}-status`, card);
    const liveText = $(`.${kind}-text`, card).value.trim();
    await maybeReviewWithWhisper({ active: { baseText: '' }, exchange, kind, card, status, audioPath, durationMs: exchange[`${kind}DurationMs`] || 0, liveText, automatic: false });
  }

  function showReviewSuggestion(card, kind, text) {
    const panel = $(`.${kind}-review-suggestion`, card);
    if (!panel) return;
    $('.review-suggestion-text', panel).textContent = text;
    panel.hidden = false;
  }

  function hideReviewSuggestion(card, kind) {
    const panel = $(`.${kind}-review-suggestion`, card);
    if (panel) panel.hidden = true;
  }

  function useReviewSuggestion(exchange, kind, card) {
    const suggestion = String(exchange[`${kind}AiCandidate`] || exchange[`${kind}AiTranscript`] || '').trim();
    if (!suggestion) return toast('Aucune proposition locale disponible.');
    const textarea = $(`.${kind}-text`, card);
    const before = textarea.value.trim();
    textarea.value = suggestion;
    if (kind === 'question') exchange.question = suggestion; else exchange.answer = suggestion;
    learnCorrectionWords(suggestion, before);
    learnCorrectionPairs(suggestion, before);
    exchange[`${kind}AiCandidate`] = '';
    exchange[`${kind}AiDecision`] = 'manual-ai';
    hideReviewSuggestion(card, kind);
    const note = $(`.${kind}-review-note`, card);
    if (note) note.textContent = 'Proposition locale utilisée.';
    saveDraft();
    toast('Correction locale appliquée.');
  }

  function dismissReviewSuggestion(exchange, kind, card) {
    exchange[`${kind}AiCandidate`] = '';
    hideReviewSuggestion(card, kind);
    const note = $(`.${kind}-review-note`, card);
    if (note) note.textContent = 'Texte direct conservé.';
    saveDraft();
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
        $('.record-label', button).textContent = kind === 'question' ? 'Enregistrer la question' : 'Enregistrer la réponse';
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
      el.textContent = 'ERREUR : pont audio natif indisponible. Vérifiez que la v3.2.2 est bien installée.';
      return;
    }
    try {
      const d = await NativeAudioRecorder.diagnostics();
      const speech = d.liveTranscriptionSupported ? 'transcription live prête' : 'transcription live selon moteur Android';
      let whisper = 'modèle local non vérifié';
      try {
        if (NativeWhisper) {
          const ws = await NativeWhisper.modelStatus({ modelId: $('#whisperModel')?.value || 'base-q5_1' });
          whisper = ws.installed ? 'modèle local prêt' : 'modèle local à installer';
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
      const reviewBtn = $(`.${kind}-review`, card); if (reviewBtn) reviewBtn.hidden = false;
      if (exchange[`${kind}AiCandidate`]) showReviewSuggestion(card, kind, exchange[`${kind}AiCandidate`]);
      return;
    }
    const clipId = exchange[`${kind}ClipId`];
    if (!clipId) return;
    const blob = await getClip(clipId);
    if (!blob) return;
    player.src = URL.createObjectURL(blob);
    player.hidden = false;
    $(`.${kind}-status`, card).textContent = `Audio conservé • ${formatDuration(exchange[`${kind}DurationMs`])}`;
    const reviewBtn = $(`.${kind}-review`, card); if (reviewBtn) reviewBtn.hidden = false;
    if (exchange[`${kind}AiCandidate`]) showReviewSuggestion(card, kind, exchange[`${kind}AiCandidate`]);
  }

  function formatDuration(ms) {
    const sec = Math.max(0, Math.round(Number(ms || 0)/1000));
    return `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
  }

  function collectDraft() {
    return {
      version: 5,
      updatedAt: new Date().toISOString(),
      investigatorGrade: $('#investigatorGrade').value,
      investigatorName: $('#investigatorName').value,
      investigatorQuality: $('#investigatorQuality').value,
      investigatorFunction: $('#investigatorFunction').value,
      investigatorUnit: $('#investigatorUnit').value,
      personRole: $('#personRole').value,
      speechLanguage: $('#speechLanguage').value,
      speechMode: getSpeechMode(),
      microProfile: $('#microProfile')?.value || 'near_field',
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
    const preSmartDraft = Number(d.version || 0) < 5;
    if (d.microProfile !== undefined && $('#microProfile')) $('#microProfile').value = d.microProfile;
    if (d.speechMode && Number(d.version || 0) >= 4) setSpeechMode(d.speechMode);
    if (d.autoTranscription !== undefined) $('#autoTranscription').checked = Boolean(d.autoTranscription);
    if (legacyDraft) $('#localSpeechOnly').checked = false;
    else if (d.localSpeechOnly !== undefined) $('#localSpeechOnly').checked = Boolean(d.localSpeechOnly);
    if (d.speechEngine && $('#speechEngine')) $('#speechEngine').value = d.speechEngine;
    if (d.whisperModel && $('#whisperModel')) $('#whisperModel').value = d.whisperModel;
    if (d.speechDictionary !== undefined && $('#speechDictionary')) $('#speechDictionary').value = d.speechDictionary;
    if (preSmartDraft) $('#aiReviewAfterStop').checked = true;
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
        const item = { question: exchange.question, answer: exchange.answer, signatureAfter: exchange.signatureAfter, transcription: { question: { live: keepLive ? (exchange.questionLiveTranscript || '') : '', cloud: exchange.questionCloudTranscript || '', cloudModel: exchange.questionCloudModel || '', cloudLatencyMs: exchange.questionCloudLatencyMs || 0, ai: exchange.questionAiTranscript || '', model: exchange.questionAiModel || '', elapsedMs: exchange.questionAiElapsedMs || 0 }, answer: { live: keepLive ? (exchange.answerLiveTranscript || '') : '', cloud: exchange.answerCloudTranscript || '', cloudModel: exchange.answerCloudModel || '', cloudLatencyMs: exchange.answerCloudLatencyMs || 0, ai: exchange.answerAiTranscript || '', model: exchange.answerAiModel || '', elapsedMs: exchange.answerAiElapsedMs || 0 } } };
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
        speechMode: { mode: getSpeechMode(), automatic: $('#autoTranscription').checked, preferOffline: $('#localSpeechOnly').checked, localOnly: getSpeechMode() === 'private', engine: $('#speechEngine')?.value || 'smart', onlineConfigured: cloudConfigured(), onlineProvider: '', microProfile: $('#microProfile')?.value || 'near_field', whisperModel: $('#whisperModel')?.value || '', whisperReview: $('#aiReviewAfterStop')?.checked === true, learnedCorrections: $('#learnFromCorrections')?.checked !== false, vocabulary: buildBiasingText().split(/\n+/).filter(Boolean) },
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
