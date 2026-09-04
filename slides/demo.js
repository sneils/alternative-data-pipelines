// Live-demo machinery for the deck: the audience photo booth and the QR
// transmitters embedded in slides. Reuses lib/protocol.js + vendor/qrcode.js from the
// demo pages - the deck and the demo are the same codebase.
const TalkDemo = (() => {
  const state = { photo: null }; // { bytes, url } once captured

  // ---- photo booth ----------------------------------------------------
  let boothStream = null;

  async function startBooth(video, statusEl) {
    try {
      boothStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 } }, audio: false,
      });
    } catch (e) {
      statusEl.textContent = 'Camera unavailable: ' + e.message + ' demo will use static noise.';
      return false;
    }
    video.srcObject = boothStream;
    await video.play();
    statusEl.textContent = '';
    return true;
  }

  async function capturePhoto(video, targetImg, statusEl) {
    if (!boothStream) return;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 800 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.6));
    state.photo = { bytes: new Uint8Array(await blob.arrayBuffer()), url: URL.createObjectURL(blob) };
    targetImg.src = state.photo.url;
    targetImg.hidden = false;
    video.hidden = true;
    stopBooth();
    transmitters.forEach(t => t.reset());   // next Start must use this photo
    statusEl.textContent = `Captured: ${state.photo.bytes.length.toLocaleString()} bytes of JPEG. This is the payload now.`;
  }

  // Back to the live view; transmitters forget the old photo.
  async function retakePhoto(video, targetImg, statusEl) {
    if (state.photo) URL.revokeObjectURL(state.photo.url);
    state.photo = null;
    targetImg.hidden = true;
    video.hidden = false;
    transmitters.forEach(t => t.reset());
    return startBooth(video, statusEl);
  }

  function stopBooth() {
    if (boothStream) {
      boothStream.getTracks().forEach(t => t.stop());
      boothStream = null;
    }
  }

  // The payload every transmitter uses: the audience photo, or a fallback
  // sample so the deck also works in rehearsal without a capture.
  function payload() {
    if (state.photo) return { bytes: state.photo.bytes, name: 'audience.jpg', mime: 'image/jpeg' };
    const bytes = new Uint8Array(30 * 1024);
    crypto.getRandomValues(bytes);
    return { bytes, name: 'sample-30k.bin', mime: 'application/octet-stream' };
  }

  // ---- QR transmitter (one per demo slide) -----------------------------
  const transmitters = [];

  class Transmitter {
    constructor(canvas, statusEl, { chunkSize = 400, fps = 10, mode = 'naive' } = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.statusEl = statusEl;
      this.chunkSize = chunkSize;
      this.fps = fps;
      this.mode = mode;
      this.frames = [];      // naive
      this.qrCache = [];
      this.ft = null;        // fountain
      this.seedBase = 0;
      this.idx = 0; this.cycles = 0; this.swaps = 0;
      this.playing = false; this.lastSwap = 0; this.startedAt = 0;
      transmitters.push(this);
    }

    loaded() { return this.frames.length > 0 || this.ft !== null; }

    load() {
      const { bytes, name, mime } = payload();
      const opts = { fileId: Protocol.randomFileId(), name, mime, chunkSize: this.chunkSize };
      let K;
      if (this.mode === 'fountain') {
        this.ft = Protocol.makeFountainContext(bytes, opts);
        const seed = new Uint32Array(1);
        crypto.getRandomValues(seed);
        this.seedBase = seed[0];
        K = this.ft.K;
        this.draw(this.qrFor(Protocol.fountainFrame(this.ft, this.seedBase)));
      } else {
        this.frames = Protocol.makeFrames(bytes, opts);
        this.qrCache = new Array(this.frames.length);
        K = this.frames.length;
        this.draw(this.naiveQr(0));
      }
      this.idx = 0; this.cycles = 0; this.swaps = 0; this.startedAt = 0;
      this.status(`${name} · ${bytes.length.toLocaleString()} bytes → ${K} chunks · ${this.mode}`);
    }

    toggle() {
      if (!this.loaded()) this.load();
      this.playing = !this.playing;
      if (this.playing && !this.startedAt) this.startedAt = performance.now();
      return this.playing;
    }

    pause() { this.playing = false; }

    // Forget the loaded payload so the next Start picks up the current photo.
    reset() {
      this.playing = false;
      this.frames = []; this.qrCache = []; this.ft = null;
      this.idx = 0; this.cycles = 0; this.swaps = 0; this.startedAt = 0;
      this.ctx.fillStyle = '#fff';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.status('');
    }

    step(now) {
      if (!this.playing || !this.loaded()) return;
      if (now - this.lastSwap < 1000 / this.fps) return;
      this.lastSwap = now;
      this.swaps++;
      let progress;
      if (this.ft) {
        this.draw(this.qrFor(Protocol.fountainFrame(this.ft, (this.seedBase + this.swaps) >>> 0)));
        progress = `frame #${this.swaps} · ${(this.swaps / this.ft.K).toFixed(2)}×K`;
      } else {
        this.idx = (this.idx + 1) % this.frames.length;
        if (this.idx === 0) this.cycles++;
        this.draw(this.naiveQr(this.idx));
        progress = `frame ${this.idx + 1}/${this.frames.length} · cycle ${this.cycles + 1}`;
      }
      const elapsed = (now - this.startedAt) / 1000;
      this.status(`${progress} · ${(this.swaps / elapsed).toFixed(1)} fps · ${elapsed.toFixed(0)}s`);
    }

    qrFor(frameString) {
      const qr = qrcode(0, 'M');
      qr.addData(frameString);
      qr.make();
      return qr;
    }

    naiveQr(i) {
      if (!this.qrCache[i]) this.qrCache[i] = this.qrFor(this.frames[i]);
      return this.qrCache[i];
    }

    draw(qr) {
      const modules = qr.getModuleCount();
      const cell = Math.max(4, Math.floor(1200 / modules));
      const size = modules * cell;
      if (this.canvas.width !== size) this.canvas.width = this.canvas.height = size;
      this.ctx.fillStyle = '#fff';
      this.ctx.fillRect(0, 0, size, size);
      this.ctx.fillStyle = '#000';
      for (let r = 0; r < modules; r++) {
        for (let c = 0; c < modules; c++) {
          if (qr.isDark(r, c)) this.ctx.fillRect(c * cell, r * cell, cell, cell);
        }
      }
    }

    status(text) { if (this.statusEl) this.statusEl.textContent = text; }
  }

  function pauseAll() { transmitters.forEach(t => { t.playing = false; }); }

  function driveAll(now) { transmitters.forEach(t => t.step(now)); }
  function rafLoop(now) { driveAll(now); requestAnimationFrame(rafLoop); }
  requestAnimationFrame(rafLoop);
  // rAF never fires in hidden tabs; keep swaps limping there (throttled to ~1/s).
  setInterval(() => driveAll(performance.now()), 250);

  return { state, startBooth, capturePhoto, retakePhoto, stopBooth, payload, Transmitter, pauseAll };
})();
