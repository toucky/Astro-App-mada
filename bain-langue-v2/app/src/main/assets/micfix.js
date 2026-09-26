(() => {
  'use strict';
  if (window.__FRANCAIS_PRATIQUE_230__) return;
  window.__FRANCAIS_PRATIQUE_230__ = true;

  try {
    document.title = 'Français Pratique';
    const brand = document.querySelector('.brand b');
    if (brand) brand.textContent = 'Français Pratique';
    const sub = document.querySelector('.brand small');
    if (sub) sub.textContent = 'APP MADA · pratique orale';
  } catch (_) {}

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

  const SAMPLE_MS = 90;
  const VOICE_THRESHOLD = 350;
  const VOICE_HANGOVER_MS = 320;
  const RELEASE_TAIL_MS = 220;

  function nativeAvailable() {
    try {
      return typeof AndroidMic !== 'undefined' &&
        typeof AndroidMic.start === 'function' &&
        typeof AndroidMic.stop === 'function' &&
        typeof AndroidMic.amplitude === 'function';
    } catch (_) { return false; }
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
      const dt = Math.max(0, Math.min(160, now - lastSampleAt));
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

  function syncRemaining(seconds) {
    state.remaining = Math.max(0, Number(seconds ?? state.remaining));
    state.wallet.remainingSeconds = state.remaining;
    try { syncDisplay(); } catch (_) {}
  }

  async function sendNativeVoiceFast(result, speechSeconds) {
    if (!result.audioBase64 || String(result.audioBase64).length < 200) {
      toast('Enregistrement vide. Réessayez.');
      return;
    }

    stopVoiceMeter('⚡ Transcription…');
    setBusy(true);
    mic.textContent = '⏳';

    const billingPromise = api('bain_speaking_charge', {
      sessionId: state.sessionId,
      seconds: Math.max(1, Math.min(300, Math.ceil(speechSeconds)))
    }).then(b => {
      syncRemaining(b.remainingSeconds);
      return b;
    }).catch(() => null);

    try {
      const t0 = performance.now();
      const t = await api('bain_transcribe_only', {
        sessionId: state.sessionId,
        audioBase64: result.audioBase64,
        mimeType: result.mimeType || 'audio/mp4'
      });

      const transcript = String(t.transcript || '').trim();
      if (!transcript) throw new Error('Phrase vide');

      addMsg('me', transcript);
      const transcribeMs = Math.round(performance.now() - t0);
      status(`✓ Texte reconnu · ${(transcribeMs / 1000).toFixed(1)} s · réponse rapide…`);

      const r0 = performance.now();
      const j = await api('bain_reply_only', {
        sessionId: state.sessionId,
        level: document.getElementById('level').value,
        scenario: document.getElementById('scenario').value,
        correctionMode: document.getElementById('correction').value,
        text: transcript
      });

      // Réponse texte affichée immédiatement, sans attendre le TTS.
      addMsg('ai', j.reply || 'Très bien.', j.correction || '');
      const replyMs = Math.round(performance.now() - r0);
      status(`✓ Réponse reçue · ${(replyMs / 1000).toFixed(1)} s · préparation de la voix…`);
      mic.textContent = '🎙';

      // Génération vocale séparée : elle ne retarde plus l'affichage du texte.
      const voiceResult = await api('bain_tts_only', {
        sessionId: state.sessionId,
        text: j.reply || 'Très bien.',
        voice: document.getElementById('voice').value,
        speed: Number(document.getElementById('speed').value)
      });

      await billingPromise;

      if (voiceResult.audioBase64) {
        await playAI(voiceResult.audioBase64, voiceResult.audioMime || 'audio/mpeg');
      } else {
        stopVoiceMeter('Compteur arrêté · maintenez le micro pour parler');
      }

      setBusy(false);
      mic.textContent = '🎙';
    } catch (e) {
      setBusy(false);
      mic.textContent = '🎙';
      stopVoiceMeter();
      toast(human(e));
      try {
        await billingPromise;
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
    } catch (_) {
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

    setTimeout(async () => {
      const voiceMs = activeSpeechMs;
      try {
        const r = parseNative(AndroidMic.stop());
        recording = false;
        stopping = false;
        stopVoiceMeter('Envoi pour transcription…');
        mic.textContent = '🎙';

        if (!r || !r.ok) {
          const detail = r && r.error ? String(r.error) : 'stop_failed';
          if (detail === 'recording_too_short') toast('Maintenez le micro un peu plus longtemps.');
          else toast('Enregistrement impossible : ' + detail);
          return;
        }
        if (voiceMs < 180) {
          toast('Aucune voix détectée. Maintenez le micro et parlez clairement.');
          status('Compteur arrêté · maintenez le micro pour parler');
          return;
        }
        await sendNativeVoiceFast(r, voiceMs / 1000);
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

  mic.onclick = null;
  mic.oncontextmenu = ev => { ev.preventDefault(); return false; };
  mic.style.touchAction = 'none';
  mic.addEventListener('pointerdown', beginPTT, {passive:false});
  mic.addEventListener('pointerup', endPTT, {passive:false});
  mic.addEventListener('pointercancel', endPTT, {passive:false});
  mic.addEventListener('lostpointercapture', () => { if (recording && !stopping) endPTT(); });

  status('Compteur arrêté · maintenez le micro pour parler');
})();
