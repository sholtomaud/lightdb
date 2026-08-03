# lightdb

A local-first database that syncs between devices **over light**. One screen
displays an animated QR stream; the other reads it with a camera. No internet,
no Bluetooth, no pairing, no radio of any kind.

Built as a [Boba](https://github.com/sholtomaud/boba) app — Web Components, ES
modules, native TypeScript type stripping, no build step in development.

## Quick start

Everything runs in a container (Apple `container` CLI, `node:26-slim`):

```sh
make image      # build the dev image
make install    # npm install inside it
make dev        # vite on :5173
```

Then open the app on two devices on the same LAN (or install it as a PWA on
each and go offline entirely).

## How a sync works

Optical transfer is **simplex** — a screen talks to a camera, and reversing it
means physically turning a device around. So the protocol converges in exactly
two passes and one flip, with no round trips inside a pass.

```
Pass 1   A's screen ──light──▶ B's camera
         A sends its version vector plus every op B is missing.
         B merges. B is now up to date and knows A's vector.

           ~~ flip the devices ~~

Pass 2   B's screen ──light──▶ A's camera
         B replies with exactly the ops A lacks.
         A merges. Both replicas have converged.
```

Each device remembers the last version vector it saw from each peer, so a
*second* sync sends only the new delta. A first-ever sync falls back to the full
op log.

### Why a CRDT

Records live in a last-writer-wins map with per-actor operation logs. Merges are
commutative, associative and idempotent, which is what makes a one-way channel
survivable:

- frames may arrive in any order,
- the same stream may be scanned twice with no ill effect,
- neither side ever needs to ask a follow-up question.

A version vector is a handful of bytes, which is why pass 1 can announce state
cheaply instead of shipping a snapshot.

### Why fountain codes

There is no back-channel, so the receiver can never say "resend frame 7". Every
frame is instead the XOR of a pseudorandom subset of payload blocks (a Luby
transform code), and the receiver reconstructs once it has collected any ~5–15%
more frames than there are blocks — in any order, with any subset missing.

Sender and receiver never exchange the block selection. Each frame carries a
32-bit seed and both sides run the identical PRNG and degree distribution.

## Architecture

```
src/optical/
  galois.ts        GF(256) + Reed-Solomon encoder
  qr-encode.ts     minimal byte-mode QR generator, versions 1-40
  fountain.ts      LT codes: robust soliton, encoder, peeling decoder
  frame.ts         24-byte self-describing wire header + CRC-32
  base64.ts        base64url (see the note below)
  transmitter.ts   canvas render loop
  scanner.ts       camera + pluggable QR decoder

src/db/
  crdt.ts          LWW map, op logs, version vectors
  idb.ts           IndexedDB persistence for the op log
  sync.ts          the two-pass protocol
```

### The QR generator

Hand-written, byte mode only. Byte mode is all we need — every payload is a
binary fountain frame, never text — so dropping numeric, alphanumeric, kanji and
ECI removes most of a general-purpose QR library.

Only two tables are irreducible: error-correction codewords per block, and block
count per version. Everything else (total capacity, block splits, alignment
positions, format bits, version bits) is computed. `test/qr-encode.test.ts`
re-derives the published capacity figures from those two tables, so a mistyped
digit cannot pass silently.

## Known limitations

**Receiving needs `BarcodeDetector`, which is Chromium-only.** Safari, iOS
(every browser on it) and Firefox have no native QR decode. Sending works
everywhere. Those platforms need a WASM decoder registered through the seam
already provided:

```ts
import { setQrDecoder } from './src/optical/scanner.ts';
setQrDecoder({ async decode(video) { /* zxing-wasm */ return []; } });
```

Nothing else in the app changes.

**Payloads travel as base64url, costing 33% expansion.** Every browser QR
decoder hands back a *string* (`BarcodeDetector` exposes `rawValue`, never raw
bytes) and the charset it assumes for QR byte mode varies by platform —
ISO-8859-1 on some, UTF-8 on others. Round-tripping arbitrary bytes through that
is not portable.

The fix is base45 over QR **alphanumeric** mode, which costs ~3% instead of 33%
— alphanumeric packs 5.5 bits per character and base45 maps 2 bytes to 3
characters, for ~8.25 bits per byte. It needs a second segment mode in the
encoder. This is the single highest-value optimisation available.

**Sync messages are JSON before gzip.** A columnar binary encoding of the op log
would roughly halve them; gzip currently recovers most of that. Worth revisiting
if payloads grow.

**One-way at a time.** The obvious next step is a near-ultrasonic audio
back-channel (~0.1–2 kbit/s over `WebAudio` out and `AudioWorklet` in). That is
far too slow for data, but ample for control — version vectors, session setup,
acks, targeted repair requests — and unlike the optical channel it runs in both
directions simultaneously, since laptops and phones all have a speaker *and* a
microphone. That would remove the flip.

## Prior art

[Decimen Optical Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer)
does fountain-coded QR *file* transfer and reports 129–190 KB/s using zxing-cpp
compiled to WASM. `lightdb` differs in aiming at replicated database state
rather than files, which is why the payloads are small deltas and the merge
semantics are conflict-free.

## Testing

```sh
make lint
make test-unit   # node --test: QR, Reed-Solomon, fountain, framing, CRDT
make test        # Playwright e2e
```
