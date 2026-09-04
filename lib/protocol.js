// Frame formats.
//
// v1 - naive sequential chunks:
//   v1|fileId|seq|total|name|mime|crc32hex|base64(chunk)
//
// v2 - LT fountain frames:
//   v2|fileId|K|fileSize|seed|name|mime|crc32hex|base64(xor of chunks)
//   Each frame is the XOR of a pseudo-random subset of the K source chunks.
//   The subset is fully determined by (seed, K): both sides run the same PRNG
//   and degree distribution, so only the 32-bit seed travels on the wire.
//   Chunks are zero-padded to chunkSize (= payload length); fileSize trims the
//   reassembled tail.
//
// Every frame is self-describing: the receiver can catch any subset, in any
// order, from any point in the stream. `name` is percent-encoded so it can't
// contain the `|` separator. The CRC covers the payload bytes.
const Protocol = (() => {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function encodeFrame({ fileId, seq, total, name, mime, chunk }) {
    return ['v1', fileId, seq, total, encodeURIComponent(name), mime,
      crc32(chunk).toString(16), bytesToBase64(chunk)].join('|');
  }

  // Returns a tagged object ({v: 1, …} or {v: 2, …}), or null for anything
  // that isn't a valid, uncorrupted frame.
  function parseFrame(text) {
    if (typeof text !== 'string') return null;
    if (text.startsWith('v1|')) {
      const parts = text.split('|');
      if (parts.length !== 8) return null;
      const [, fileId, seqS, totalS, nameEnc, mime, crcHex, b64] = parts;
      const seq = Number(seqS), total = Number(totalS);
      if (!Number.isInteger(seq) || !Number.isInteger(total) || seq < 0 || seq >= total) return null;
      let chunk, name;
      try {
        chunk = base64ToBytes(b64);
        name = decodeURIComponent(nameEnc);
      } catch {
        return null;
      }
      if (crc32(chunk).toString(16) !== crcHex) return null;
      return { v: 1, fileId, seq, total, name, mime, chunk };
    }
    if (text.startsWith('v2|')) {
      const parts = text.split('|');
      if (parts.length !== 9) return null;
      const [, fileId, kS, sizeS, seedS, nameEnc, mime, crcHex, b64] = parts;
      const K = Number(kS), fileSize = Number(sizeS), seed = Number(seedS);
      if (!Number.isInteger(K) || K < 1) return null;
      if (!Number.isInteger(fileSize) || fileSize < 0) return null;
      if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) return null;
      let xor, name;
      try {
        xor = base64ToBytes(b64);
        name = decodeURIComponent(nameEnc);
      } catch {
        return null;
      }
      if (fileSize > K * xor.length) return null;
      if (crc32(xor).toString(16) !== crcHex) return null;
      return { v: 2, fileId, K, fileSize, seed, name, mime, xor };
    }
    return null;
  }

  function makeFrames(bytes, { fileId, name, mime, chunkSize }) {
    const total = Math.max(1, Math.ceil(bytes.length / chunkSize));
    const frames = [];
    for (let seq = 0; seq < total; seq++) {
      frames.push(encodeFrame({
        fileId, seq, total, name, mime,
        chunk: bytes.subarray(seq * chunkSize, (seq + 1) * chunkSize),
      }));
    }
    return frames;
  }

  function randomFileId() {
    const b = new Uint8Array(4);
    crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }

  // ---- LT fountain code ---------------------------------------------------

  // Deterministic 32-bit PRNG (mulberry32) - must produce identical sequences
  // on sender and receiver.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Robust soliton distribution over degrees 1..K. Returns the normalized
  // per-degree probabilities (pmf[0]=0; pmf[1..K] sum to 1) plus the robust
  // spike location. This is what shapes the "mostly 1s and 2s, with a spike of
  // big mixes to sweep up stragglers" degree profile.
  function solitonPmf(K, c = 0.05, delta = 0.5) {
    const S = Math.max(1, Math.ceil(c * Math.log(K / delta) * Math.sqrt(K)));
    const pivot = Math.max(1, Math.min(K, Math.floor(K / S)));
    const pmf = new Array(K + 1).fill(0);
    for (let d = 1; d <= K; d++) {
      pmf[d] = d === 1 ? 1 / K : 1 / (d * (d - 1));  // ideal soliton
      if (d < pivot) pmf[d] += S / (K * d);           // robust boost for small degrees
      else if (d === pivot) pmf[d] += (S / K) * Math.log(S / delta);
    }
    const sum = pmf.reduce((a, x) => a + x, 0);
    for (let d = 1; d <= K; d++) pmf[d] /= sum;
    return { pmf, pivot, S };
  }

  // Same distribution as a CDF, for sampling a degree from a uniform draw.
  function solitonCdf(K, c = 0.05, delta = 0.5) {
    const { pmf } = solitonPmf(K, c, delta);
    const cdf = new Array(K + 1).fill(0);
    let acc = 0;
    for (let d = 1; d <= K; d++) { acc += pmf[d]; cdf[d] = acc; }
    cdf[K] = 1;
    return cdf;
  }

  // The chunk subset a frame XORs together - fully determined by (seed, K).
  function frameIndices(seed, K, cdf) {
    const rnd = mulberry32(seed);
    const u = rnd();
    let d = 1;
    while (d < K && u > cdf[d]) d++;
    const chosen = new Set();
    while (chosen.size < d) chosen.add(Math.floor(rnd() * K));
    return chosen;
  }

  function xorInto(target, src) {
    for (let i = 0; i < target.length; i++) target[i] ^= src[i];
  }

  // Sender side: split + zero-pad the payload once, then generate frames from seeds.
  function makeFountainContext(bytes, { fileId, name, mime, chunkSize }) {
    const K = Math.max(1, Math.ceil(bytes.length / chunkSize));
    const chunks = [];
    for (let i = 0; i < K; i++) {
      const chunk = new Uint8Array(chunkSize);
      chunk.set(bytes.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, bytes.length)));
      chunks.push(chunk);
    }
    return { fileId, name, mime, K, fileSize: bytes.length, chunkSize, chunks, cdf: solitonCdf(K) };
  }

  function fountainFrame(ctx, seed) {
    const xor = new Uint8Array(ctx.chunkSize);
    for (const idx of frameIndices(seed, ctx.K, ctx.cdf)) xorInto(xor, ctx.chunks[idx]);
    return ['v2', ctx.fileId, ctx.K, ctx.fileSize, seed, encodeURIComponent(ctx.name),
      ctx.mime, crc32(xor).toString(16), bytesToBase64(xor)].join('|');
  }

  // Receiver side: classic peeling decoder. Feed frames in any order; solved
  // chunks are XORed out of pending mixtures until new degree-1 frames appear.
  class FountainDecoder {
    constructor(K, chunkSize) {
      this.K = K;
      this.chunkSize = chunkSize;
      this.cdf = solitonCdf(K);
      this.decoded = new Array(K).fill(null);
      this.decodedCount = 0;
      this.pending = [];       // { indices: Set, data: Uint8Array }
      this.seenSeeds = new Set();
    }

    // Returns the number of chunks this frame newly solved (0 = redundant).
    addFrame(seed, xor) {
      if (this.done() || this.seenSeeds.has(seed)) return 0;
      this.seenSeeds.add(seed);
      const indices = frameIndices(seed, this.K, this.cdf);
      const data = xor.slice(0, this.chunkSize);
      for (const idx of [...indices]) {
        if (this.decoded[idx]) {
          xorInto(data, this.decoded[idx]);
          indices.delete(idx);
        }
      }
      if (indices.size === 0) return 0;
      this.pending.push({ indices, data });
      return this.peel();
    }

    peel() {
      let solved = 0;
      let progress = true;
      while (progress) {
        progress = false;
        for (let i = this.pending.length - 1; i >= 0; i--) {
          const p = this.pending[i];
          for (const idx of [...p.indices]) {
            if (this.decoded[idx]) {
              xorInto(p.data, this.decoded[idx]);
              p.indices.delete(idx);
            }
          }
          if (p.indices.size === 0) {
            this.pending.splice(i, 1);
          } else if (p.indices.size === 1) {
            const idx = p.indices.values().next().value;
            this.decoded[idx] = p.data;
            this.decodedCount++;
            solved++;
            this.pending.splice(i, 1);
            progress = true;
          }
        }
      }
      return solved;
    }

    done() { return this.decodedCount === this.K; }

    assemble(fileSize) {
      const out = new Uint8Array(this.K * this.chunkSize);
      for (let i = 0; i < this.K; i++) out.set(this.decoded[i], i * this.chunkSize);
      return out.subarray(0, fileSize);
    }
  }

  return {
    crc32, bytesToBase64, base64ToBytes, encodeFrame, parseFrame, makeFrames, randomFileId,
    makeFountainContext, fountainFrame, FountainDecoder, solitonPmf
  };
})();
