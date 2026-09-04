# QR Transfer

File transfer across the room with no network: the sender plays chunks of a file
as a stream of QR codes, the receiver's camera catches them and reassembles the
file. Demo project for a conference talk (framing, Reed-Solomon, fountain codes,
channel capacity).

Everything is static HTML - no build step, no backend, no runtime CDN
dependencies (the receiver must keep working in airplane mode).

## Files

- `tools/sender.html` - chunks a file (or pasted text) into protocol frames and plays them
  as a QR loop; mode switch (naive / fountain), chunk size and fps controls;
  shows a QR of the receiver URL so a phone can get there without typing;
  the meta line carries the payload's SHA-256 fingerprint (matches the receiver's)
- `tools/receiver.html` - camera + decode loop (`BarcodeDetector` on Chrome/Android,
  `jsQR` fallback), reassembles chunks, shows progress bar / chunk grid /
  missing list, renders the result (image preview, text, or download link),
  and on completion shows what arrived - images and small text as themselves,
  anything else as a byte-map (one grey pixel per byte) - always with a SHA-256
  fingerprint to compare against the sender's, plus run-stats JSON (K, framesRx,
  duration, goodput, scan rate) with a copy button - the measurements log input.
  Also shows a QR of its own URL so the audience join spreads phone to phone.
- `lib/protocol.js` - shared frame protocol + fountain code. Two formats:
  `v1|fileId|seq|total|name|mime|crc32|base64(chunk)` (naive) and
  `v2|fileId|K|fileSize|seed|name|mime|crc32|base64(xor)` (LT fountain).
  Every frame is self-describing; catch any subset in any order. CRC-32 guards
  each frame; a new `fileId` resets the receiver session. The LT coder
  (mulberry32 PRNG + robust-soliton degrees + peeling decoder) is hand-written:
  only the 32-bit `seed` travels, and both sides replay the same chunk
  selection from it - measured ~1.25×K overhead at photo scale.
- `worker.js` - service worker for the receiver: precaches `tools/receiver.html`,
  `lib/protocol.js`, `vendor/jsQR.js`, `vendor/qrcode.js` so a reload with no network still works (the
  airplane-mode proof). Root scope is required - the receiver's assets live at
  the root, so a narrower scope couldn't control them. Policy: the versioned core
  files are cache-first; everything else (pages, `measurements.json`, the deck)
  is network-first with the cached copy as offline fallback, so edits show up
  immediately when online. Bump `CACHE` and keep its `?v=` in sync with the
  receiver's `<script>` tags when either changes.
- `vendor/` - `qrcode-generator` 1.4.4 (encode), `jsQR` 1.4.0 (decode),
  `reveal.js` 5.1.0 (slides)
- `tools/measure.html` - measurement sweep: runs the real `lib/protocol.js` codec over
  controlled frame-loss rates (no camera) and charts naive vs fountain
  time-to-complete plus fountain overhead. Copy-JSON/CSV to refresh
  `slides/measurements.json`, which the deck's chart slides render from.
- `slides/` - the slide deck (`slides/index.html`), served from the same folder as
  the demo. The deck imports `lib/protocol.js` + `qrcode.js` directly: the photo-booth
  slide captures (or retakes) the audience photo, and the transmit slides play it as QR
  frames - the deck *is* the sender on stage. Keys: arrows to navigate, `S`
  speaker notes, `F` fullscreen, `Esc` overview; append `?print-pdf` and print
  for the organizer's PDF copy. Both transmit slides carry the audience
  join-QR (bottom-right). `slides/deep-dive.html` is where the anatomy slide's sample QR
  leads - an own-domain decoy page so scanner previews don't spoil the
  destination (needs public hosting for audience phones on cellular).

Console hooks for driving without a camera (also used by the tests):
`senderApi.setPayload(bytes, name, mime)` and `receiverApi.injectFrame(frameString)`.

## Run

```
python3 -m http.server 8123
```

Camera access requires a secure context: `localhost` works, plain `http://<ip>`
does not.

## v0 test without any HTTPS setup

The sender needs no camera, so flip the direction for the first physical test:

1. Laptop: open `http://localhost:8123/tools/receiver.html`, start the webcam.
2. Phone: open `http://<laptop-ip>:8123/tools/sender.html` (insecure origin is fine -
   this page only renders).
3. Hold the phone's QR up to the laptop webcam until the text appears.

For the real direction (laptop screen → phone camera) the receiver page must be
on `https://` for the phone - that's what the GitHub Pages hosting below is for
(or `adb reverse tcp:8123 tcp:8123` on Android to make it `localhost`).

## Hosting (GitHub Pages)

Repo: `github.com/sneils/alternative-data-pipelines` · Pages:
`https://sneils.github.io/alternative-data-pipelines/`

Live since 2026-09-04. One-time setup, kept for reference:

```
git add -A
git commit -m "feat: qr transfer demo (v0/v1) and talk deck scaffold"
gh repo create alternative-data-pipelines --public --source . --remote origin --push
gh api -X POST repos/sneils/alternative-data-pipelines/pages -f "source[branch]=main" -f "source[path]=/"
```

After that: every push to `main` redeploys the public site (~1 min). The pages
that matter:

- `…/tools/receiver.html` - open on the phone (HTTPS → camera allowed): the real
  transfer direction works from here on
- `…/slides/` - the deck; its join-QR and rickroll-QR resolve to the Pages URLs
  automatically
- everything is world-readable - nothing sensitive belongs in this repo

## Roadmap

- [x] v0 - one QR, one payload, decode loop works
- [x] v1 - chunk a ~50 KB file, naive loop 1..N, reassemble (watch it stall at ~97%)
- [x] deck scaffold - reveal.js (vendored), 22 outline slides, photo booth +
      transmit slides wired to the shared modules
- [x] v2 - LT fountain code encoder/decoder (hand-written); sender mode switch,
      receiver decodes both formats, deck fountain slide un-stubbed
- [x] offline receiver - service worker precache (survives reload with no
      network) + screen wake-lock; "safe to disconnect" badge
- [x] measurement sweep - `tools/measure.html` → `slides/measurements.json`;
      deck's coupon-collector and before/after chart slides render from it
      (2 of the deck's chart TODOs closed with real codec data)
- [x] peeling-decoder walkthrough slide - real peeling over a curated 5-chunk /
      6-frame set, stepped by reveal fragments (→/←), with a redundant frame
      showing overhead ε
- [x] soliton slide - degree histogram rendered live from `Protocol.solitonPmf` in
      lib/protocol.js (K=64): degree-2 bulk, degree-1 seeds, robust spike at K/S
- [x] deck diagrams (inline SVG) - stage setup (laptop→air→phone, one-way) and
      naive chunk loop (file→chunks→loop forever)
- [x] bandwidth waterfall slide - bars 1–3 computed live from QR/protocol
      constants; bars 4–6 from the on-camera `run` in `slides/measurements.json`
      (paste the receiver's "Copy run stats" JSON + the sender's `fps`). First
      two real runs recorded in `runs`; the slide renders `run` = the fountain
      one (captured JPEG, K=62, jsQR @ 12 scans/s: 51% frames missed, 1.16×
      frames/chunk → 1,671 B/s measured vs 1,698 derived). Naive run for
      comparison: K=77 @ 15 scans/s, 25% missed, 1.64× dups → 1,818 vs 1,823.
- [x] encore (ggwave) - cut; enough content already
- [ ] v3 - standalone `sender.html` webcam capture (the deck already captures
      the audience photo; the demo page still only takes file/sample/text)
- [~] v4 - progress bar / throughput / photo reveal all done; remaining polish TBD
