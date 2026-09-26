(() => {
  'use strict';
  if (window.__BAIN_NATIVE_PTT_223__) return;
  window.__BAIN_NATIVE_PTT_223__ = true;

  // index.html still owns old getUserMedia listeners. Cloning the microphone
  // button removes those listeners completely before native PTT is attached.
  const legacyMic = document.getElementById('micBtn');
  if (!legacyMic || typeof state === 'undefined') return;
  const mic = legacyMic.cloneNode(true);
  legacyMic.replaceWith(mic);

  let recording = false;
  let stopping = false;
  let pointerId = null;
  let ampTimer = null;
  let activeSpeechMs = 0;
  let lastSampleAt = 0;
  let lastVoiceAt = 0;
  let speaking = false;

  const SAMPLE_MS = 100;
  const VOICE_THRESHOLD = 350;
  const VOICE_HANGOVER_MS = 360;
  const RELEASE_TAIL_MS = 280;

  function nativeAvailable() {
    try {
      return typeof AndroidMic !== 'undefined' &&
        typeof AndroidMic.start === 'function' &&
        typeof AndroidMic.stop === 'function' &&
        typeof AndroidMic.amplitude === 'function';
    } catch (_) {
      return false;
    }
  }

  function parseNative(v) {
    try { return typeof v === 'string' ? JSON.parse(v) : v; }
    catch (_) { return {ok:false,error:'invalid_native_response'}; }
  }

  function stopVoiceMeter(label='Compteur arrêté · maintenez le micro pour parler') {
    if (ampTimer) clearInterval(ampTimer);
    ampTimer = null;
    speaking = false;
    try { stopMeter(label); } catch (_) {
      const e = document.getElementById('statusText');
      if (e) e.textContent = label;
    }
  }

  function startVoiceMeter() {
    activeSpeechMs = 0;
    lastSampleAt = performance.now();
    lastVoiceAt = 0;
    speaking = false;
    if (ampTimer) clearInterval(ampTimer);

    ampTimer = setInterval(() => {
      if (!recording) return;
      const now = performance.now();
      const dt = Math.max(0, Math.min(180, now - lastSampleAt));
      lastSampleAt = now;
      let amp = 0;
      try { amp = Number(AndroidMic.amplitude()) || 0; } catch (_) {}

      if (amp >= VOICE_THRESHOLD) {
        lastVoiceAt = now;
        if (!speaking) {
          speaking = true;
          try { startMeter('🎙 Vous parlez · compteur actif'); } catch (_) {}
        }
      } else if (speaking && lastVoiceAt && now - lastVoiceAt > VOICE_HANGOVER_MS) {
        speaking = false;
        try { stopMeter('Silence · compteur arrêté'); } catch (_) {}
      }

      if (speaking) activeSpeechMs += dt;
    }, SAMPLE_MS);
  }

  async function sendNativeVoice(result, speechSeconds) {
    if (!result.audioBase64 || String(result.audioBase64).length < 200) {
      toast('Enregistrement vide. Réessayez.');
      return;
    }

    stopVoiceMeter('Compteur arrêté · analyse de votre phrase…');
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
        audioBase64: result.audioBase64,
        mimeType: result.mimeType || 'audio/mp4',
        speechSeconds: Math.max(1, Math.min(300, Math.ceil(speechSeconds)))
      });

      state.remaining = Number(j.remainingSeconds ?? state.remaining);
      state.wallet.remainingSeconds = state.remaining;
      syncDisplay();
      addMsg('me', j.transcript || '🎙 Message vocal');
      addMsg('ai', j.reply || 'Très bien.', j.correction || '');

      setBusy(false);
      mic.textContent = '🎙';
      if (j.audioBase64) {
        await playAI(j.audioBase64, j.audioMime || 'audio/mpeg');
      } else {
        stopVoiceMeter('Compteur arrêté · maintenez le micro pour parler');
      }
    } catch (e) {
      setBusy(false);
      mic.textContent = '🎙';
      stopVoiceMeter();
      toast(human(e));
      try {
        await load(false);
        if (state.sessionId) {
          state.remaining = Number(state.wallet.remainingSeconds || state.remaining);
          syncDisplay();
        }
      } catch (_) {}
    }
  }

  async function beginPTT(e) {
    if (e) {
      e.preventDefault();
      pointerId = e.pointerId ?? null;
      try { if (pointerId !== null) mic.setPointerCapture(pointerId); } catch (_) {}
    }
    if (!state.sessionId) return toast('Démarrez d’abord la conversation.');
    if (state.busy || recording || stopping) return;
    if (Number(state.remaining || 0) <= 0) return toast('Votre forfait est terminé.');
    if (!nativeAvailable()) return toast('Module micro Android non chargé. Fermez puis rouvrez cette version.');

    try {
      if (typeof AndroidMic.hasPermission === 'function' && !AndroidMic.hasPermission()) {
        return toast('Autorisation microphone refusée dans Android.');
      }

      const r = parseNative(AndroidMic.start());
      if (!r || !r.ok) {
        const detail = r && r.error ? String(r.error) : 'start_failed';
        return toast('Démarrage micro impossible : ' + detail);
      }

      recording = true;
      stopping = false;
      mic.classList.add('down');
      mic.textContent = '●';
      status('Micro ouvert · parlez en maintenant le bouton');
      startVoiceMeter();
    } catch (err) {
      recording = false;
      stopping = false;
      mic.classList.remove('down');
      mic.textContent = '🎙';
      stopVoiceMeter();
      toast('Erreur du micro Android.');
    }
  }

  function endPTT(e) {
    if (e) e.preventDefault();
    mic.classList.remove('down');
    if (!recording || stopping) return;
    stopping = true;
    status('Fin de phrase…');

    // Keep a short recording tail after finger release to preserve the final syllable.
    setTimeout(async () => {
      const voiceMs = activeSpeechMs;
      try {
        const r = parseNative(AndroidMic.stop());
        recording = false;
        stopping = false;
        stopVoiceMeter('Compteur arrêté · envoi de votre phrase…');
        mic.textContent = '🎙';

        if (!r || !r.ok) {
          const detail = r && r.error ? String(r.error) : 'stop_failed';
          if (detail === 'recording_too_short') toast('Maintenez le micro un peu plus longtemps.');
          else toast('Enregistrement impossible : ' + detail);
          return;
        }

        // Do not consume credit if no real voice was detected.
        if (voiceMs < 180) {
          toast('Aucune voix détectée. Maintenez le micro et parlez clairement.');
          status('Compteur arrêté · maintenez le micro pour parler');
          return;
        }

        await sendNativeVoice(r, voiceMs / 1000);
      } catch (_) {
        recording = false;
        stopping = false;
        mic.textContent = '🎙';
        stopVoiceMeter();
        try { AndroidMic.cancel(); } catch (_) {}
        toast('Erreur lors de l’envoi vocal.');
      }
    }, RELEASE_TAIL_MS);
  }

  // The cloned button has no legacy WebView listeners. Only native PTT remains.
  mic.onclick = null;
  mic.oncontextmenu = ev => { ev.preventDefault(); return false; };
  mic.style.touchAction = 'none';
  mic.addEventListener('pointerdown', beginPTT, {passive:false});
  mic.addEventListener('pointerup', endPTT, {passive:false});
  mic.addEventListener('pointercancel', endPTT, {passive:false});
  mic.addEventListener('lostpointercapture', () => {
    if (recording && !stopping) endPTT();
  });

  status('Compteur arrêté · maintenez le micro pour parler');
})();
