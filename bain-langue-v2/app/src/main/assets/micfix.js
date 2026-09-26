(() => {
  'use strict';
  if (window.__BAIN_NATIVE_PTT_221__) return;
  window.__BAIN_NATIVE_PTT_221__ = true;

  const mic = document.getElementById('micBtn');
  const timer = document.getElementById('timer');
  if (!mic || typeof state === 'undefined') return;

  // The main timer must never run during silence / API waiting.
  try { clearInterval(state.timerHandle); } catch (_) {}
  state.timerHandle = null;
  window.tickTimer = function(){};

  const oldStartSession = window.startSession;
  if (typeof oldStartSession === 'function') {
    window.startSession = async function(...args) {
      const r = await oldStartSession.apply(this, args);
      try { clearInterval(state.timerHandle); } catch (_) {}
      state.timerHandle = null;
      if (timer) timer.textContent = minLabel(state.sessionRemaining);
      return r;
    };
    const startBtn = document.getElementById('startBtn');
    if (startBtn) startBtn.onclick = window.startSession;
  }

  let pointerId = null;
  let recording = false;
  let stopping = false;
  let ampTicker = null;
  let activeSpeechMs = 0;
  let lastVoiceAt = 0;
  const SAMPLE_MS = 100;
  const VOICE_THRESHOLD = 650;
  const VOICE_HANGOVER_MS = 320;
  const RELEASE_TAIL_MS = 260;

  function nativeAvailable() {
    try {
      return typeof AndroidMic !== 'undefined' &&
        typeof AndroidMic.start === 'function' &&
        typeof AndroidMic.stop === 'function';
    } catch (_) {
      return false;
    }
  }

  function parseNative(value) {
    try {
      return typeof value === 'string' ? JSON.parse(value) : value;
    } catch (_) {
      return { ok: false, error: 'invalid_native_response' };
    }
  }

  function syncBalance(seconds) {
    const s = Math.max(0, Number(seconds || 0));
    state.sessionRemaining = s;
    state.wallet.remainingSeconds = s;
    if (timer) timer.textContent = minLabel(s);
    const top = document.getElementById('walletTop');
    const inline = document.getElementById('walletInline');
    const speak = document.getElementById('speakWallet');
    const profile = document.getElementById('profileWallet');
    if (top) top.textContent = minLabel(s);
    if (inline) inline.textContent = minLabel(s);
    if (speak) speak.textContent = minLabel(s);
    if (profile) profile.textContent = minLabel(s);
  }

  function renderPreview() {
    const used = Math.max(0, Math.floor(activeSpeechMs / 1000));
    const preview = Math.max(0, Number(state.sessionRemaining || 0) - used);
    if (timer) timer.textContent = minLabel(preview);
    const top = document.getElementById('walletTop');
    if (top) top.textContent = minLabel(preview);
  }

  function stopPreview() {
    clearInterval(ampTicker);
    ampTicker = null;
    if (timer) timer.textContent = minLabel(state.sessionRemaining);
    const top = document.getElementById('walletTop');
    if (top) top.textContent = minLabel(state.sessionRemaining);
  }

  function startVoiceMeter() {
    activeSpeechMs = 0;
    lastVoiceAt = 0;
    clearInterval(ampTicker);
    ampTicker = setInterval(() => {
      if (!recording) return;
      let amp = 0;
      try { amp = Number(AndroidMic.amplitude()) || 0; } catch (_) {}
      const now = performance.now();
      if (amp >= VOICE_THRESHOLD) lastVoiceAt = now;
      if (lastVoiceAt && (now - lastVoiceAt) <= VOICE_HANGOVER_MS) {
        activeSpeechMs += SAMPLE_MS;
      }
      renderPreview();
    }, SAMPLE_MS);
  }

  async function sendVoiceBase64(audioBase64, mimeType, speechSeconds) {
    if (!audioBase64 || audioBase64.length < 200) {
      toast('Enregistrement vide. Réessayez en maintenant le micro.');
      return;
    }
    setBusy(true);
    mic.textContent = '⏳';
    try {
      const j = await api('bain_conversation_audio', {
        sessionId: state.sessionId,
        level: document.getElementById('level').value,
        scenario: document.getElementById('scenario').value,
        correctionMode: document.getElementById('correction').value,
        voice: document.getElementById('voice').value,
        speed: Number(document.getElementById('speed').value),
        audioBase64,
        mimeType: mimeType || 'audio/mp4',
        speechSeconds: Math.max(1, Math.min(300, Math.ceil(Number(speechSeconds) || 1)))
      });
      syncBalance(Number(j.remainingSeconds ?? state.sessionRemaining));
      addMessage('me', j.transcript || '🎙 Message vocal');
      addMessage('ai', j.reply || 'Très bien.', j.correction || '');
      if (j.audioBase64) playAudio(j.audioBase64, j.audioMime || 'audio/mpeg');
    } catch (e) {
      if (e && e.code === 'insufficient_minutes') syncBalance(0);
      toast(humanError(e));
    } finally {
      setBusy(false);
      mic.textContent = '🎙';
    }
  }

  async function beginPTT(e) {
    if (e) {
      e.preventDefault();
      pointerId = e.pointerId ?? null;
      try { if (pointerId !== null) mic.setPointerCapture(pointerId); } catch (_) {}
    }
    if (!state.sessionId) {
      toast('Démarrez d’abord la conversation.');
      return;
    }
    if (state.busy || recording || stopping) return;
    if (Number(state.sessionRemaining || 0) <= 0) {
      toast('Votre temps est terminé.');
      return;
    }
    if (!nativeAvailable()) {
      toast('Le module micro Android n’est pas chargé. Fermez puis rouvrez cette nouvelle version.');
      return;
    }
    try {
      if (typeof AndroidMic.hasPermission === 'function' && !AndroidMic.hasPermission()) {
        toast('Autorisation microphone refusée dans Android.');
        return;
      }
      const result = parseNative(AndroidMic.start());
      if (!result || !result.ok) {
        toast('Le micro Android n’a pas pu démarrer. Réessayez.');
        return;
      }
      recording = true;
      stopping = false;
      mic.classList.add('rec');
      mic.textContent = '●';
      startVoiceMeter();
    } catch (_) {
      recording = false;
      stopping = false;
      stopPreview();
      mic.classList.remove('rec');
      mic.textContent = '🎙';
      toast('Erreur du micro Android. Fermez puis rouvrez l’application.');
    }
  }

  function endPTT(e) {
    if (e) e.preventDefault();
    if (!recording || stopping) return;
    stopping = true;

    // Keep a very short tail after finger release so the final syllable is not cut.
    setTimeout(async () => {
      try {
        const speechSeconds = Math.max(1, Math.ceil(activeSpeechMs / 1000));
        const result = parseNative(AndroidMic.stop());
        recording = false;
        stopping = false;
        stopPreview();
        mic.classList.remove('rec');
        mic.textContent = '🎙';

        if (!result || !result.ok) {
          if (result && result.error === 'recording_too_short') {
            toast('Maintenez le micro un peu plus longtemps pendant votre phrase.');
          } else {
            toast('Enregistrement micro impossible. Réessayez.');
          }
          return;
        }
        await sendVoiceBase64(result.audioBase64, result.mimeType || 'audio/mp4', speechSeconds);
      } catch (_) {
        recording = false;
        stopping = false;
        stopPreview();
        mic.classList.remove('rec');
        mic.textContent = '🎙';
        try { AndroidMic.cancel(); } catch (_) {}
        toast('Erreur lors de l’envoi du message vocal.');
      }
    }, RELEASE_TAIL_MS);
  }

  // Replace the old click-to-start / click-to-stop microphone completely.
  mic.onclick = null;
  mic.oncontextmenu = e => { e.preventDefault(); return false; };
  mic.style.touchAction = 'none';
  mic.addEventListener('pointerdown', beginPTT, { passive: false });
  mic.addEventListener('pointerup', endPTT, { passive: false });
  mic.addEventListener('pointercancel', endPTT, { passive: false });
  mic.addEventListener('lostpointercapture', () => { if (recording && !stopping) endPTT(); });

  const liveSub = document.getElementById('liveSub');
  if (liveSub) liveSub.title = 'Maintenez le micro pendant toute votre phrase, puis relâchez pour envoyer';
})();
