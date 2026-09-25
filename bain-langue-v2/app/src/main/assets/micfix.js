(() => {
  'use strict';
  if (window.__BAIN_PTT_211__) return;
  window.__BAIN_PTT_211__ = true;

  const mic = document.getElementById('micBtn');
  const timer = document.getElementById('timer');
  if (!mic || !window.state) return;

  // Le solde ne descend plus pendant les silences ou l'attente IA.
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
  let starting = false;
  let recording = false;
  let releaseRequested = false;
  let startedAt = 0;
  let pttTicker = null;

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

  function showLivePreview() {
    clearInterval(pttTicker);
    pttTicker = setInterval(() => {
      if (!recording) return;
      const used = Math.max(0, Math.floor((performance.now() - startedAt) / 1000));
      const preview = Math.max(0, Number(state.sessionRemaining || 0) - used);
      if (timer) timer.textContent = minLabel(preview);
      const top = document.getElementById('walletTop');
      if (top) top.textContent = minLabel(preview);
    }, 250);
  }

  function stopPreview() {
    clearInterval(pttTicker);
    pttTicker = null;
    if (timer) timer.textContent = minLabel(state.sessionRemaining);
    const top = document.getElementById('walletTop');
    if (top) top.textContent = minLabel(state.sessionRemaining);
  }

  function chooseMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4'
    ];
    return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
  }

  async function sendVoice(blob, speechSeconds) {
    if (!blob || blob.size < 300) {
      toast('Enregistrement trop court. Maintenez le micro pendant que vous parlez.');
      return;
    }
    setBusy(true);
    mic.textContent = '⏳';
    try {
      const audioBase64 = await blobToBase64(blob);
      const j = await api('bain_conversation_audio', {
        sessionId: state.sessionId,
        level: document.getElementById('level').value,
        scenario: document.getElementById('scenario').value,
        correctionMode: document.getElementById('correction').value,
        voice: document.getElementById('voice').value,
        speed: Number(document.getElementById('speed').value),
        audioBase64,
        mimeType: blob.type || 'audio/webm',
        speechSeconds
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
    if (state.busy || starting || recording) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast('Micro non disponible sur cet appareil.');
      return;
    }
    if (Number(state.sessionRemaining || 0) <= 0) {
      toast('Votre temps est terminé.');
      return;
    }

    releaseRequested = false;
    starting = true;
    mic.classList.add('rec');
    mic.textContent = '●';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });
      state.stream = stream;
      state.chunks = [];
      const mime = chooseMime();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      state.recorder = recorder;
      recorder.ondataavailable = ev => { if (ev.data && ev.data.size) state.chunks.push(ev.data); };
      recorder.onerror = () => {
        recording = false;
        stopPreview();
        try { stopStream(); } catch (_) {}
        mic.classList.remove('rec');
        mic.textContent = '🎙';
        toast('Erreur microphone. Réessayez.');
      };
      recorder.onstop = async () => {
        const durationMs = Math.max(0, performance.now() - startedAt);
        const speechSeconds = Math.max(1, Math.min(300, Math.ceil(durationMs / 1000)));
        recording = false;
        starting = false;
        stopPreview();
        const type = recorder.mimeType || mime || 'audio/webm';
        const blob = new Blob(state.chunks || [], { type });
        try { stopStream(); } catch (_) {}
        mic.classList.remove('rec');
        mic.textContent = '🎙';
        await sendVoice(blob, speechSeconds);
      };
      recorder.start(120);
      startedAt = performance.now();
      recording = true;
      starting = false;
      showLivePreview();
      if (releaseRequested) setTimeout(endPTT, 180);
    } catch (err) {
      starting = false;
      recording = false;
      stopPreview();
      try { stopStream(); } catch (_) {}
      mic.classList.remove('rec');
      mic.textContent = '🎙';
      toast('Autorisez le microphone puis maintenez 🎙 pour parler.');
    }
  }

  function endPTT(e) {
    if (e) e.preventDefault();
    releaseRequested = true;
    if (starting && !recording) return;
    if (recording && state.recorder && state.recorder.state === 'recording') {
      try { state.recorder.stop(); } catch (_) {}
    }
  }

  // Supprime le comportement « un clic pour démarrer, un autre pour arrêter ».
  mic.onclick = null;
  mic.oncontextmenu = e => { e.preventDefault(); return false; };
  mic.style.touchAction = 'none';
  mic.addEventListener('pointerdown', beginPTT, { passive: false });
  mic.addEventListener('pointerup', endPTT, { passive: false });
  mic.addEventListener('pointercancel', endPTT, { passive: false });
  mic.addEventListener('lostpointercapture', () => { if (recording) endPTT(); });

  const liveSub = document.getElementById('liveSub');
  if (liveSub) liveSub.title = 'Maintenir le micro pour parler, relâcher pour envoyer';
})();
