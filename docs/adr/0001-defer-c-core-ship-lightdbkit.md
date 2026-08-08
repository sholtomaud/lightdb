# ADR 0001 — Defer the C core, ship LightDBKit, fix the ABI boundary at decoded payloads

- **Status:** Accepted
- **Date:** 2026-08-08
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

To sell `lightdb` as a B2B SDK for air-gapped synchronisation, we evaluated
packaging the fountain codec, frame assembly and CRDT engine as a closed-source
C-ABI binary (`liblightdb`) consumable from Swift, Kotlin, C# and Rust.

An audit of the proposal against the actual repository found three problems.

**There is no C or C++ core to package.** The codebase is 20 TypeScript files
and 23 Swift files sharing no code — they share `spec/vectors/`. The proposal
was written as a packaging exercise but is in fact a third full implementation
of the protocol, plus the retirement or rebasing of two that work today. That
cost dominates everything else and was unpriced.

**The proposed boundary was drawn at raw camera frames.** An API taking
`(frame_bytes, width, height, bytes_per_row)` makes the library responsible for
QR *detection and decoding*. That discards the single biggest reason the native
app performs well: Apple's Vision framework handles blur, angle and partial
occlusion far better than a bundled decoder, is hardware-accelerated, and costs
nothing. Android's ML Kit is equivalent. A C library would have to ship
zxing-cpp, grow by megabytes, and would likely *underperform* the platform
decoder it replaced. The valuable and genuinely hard-to-reproduce part of
lightdb is the protocol — deterministic fountain selection, framing, CRDT merge
semantics — not barcode detection.

**The protocol is not stable.** It is at version 2, running QR version 14 at
roughly 3.7 KB/s. A ~6× gain sits in a one-line version change; base45 over QR
alphanumeric mode would change the transport encoding outright; frame yield has
not been instrumented, so nobody yet knows the real numbers. A C ABI is a
promise that cannot be retracted once customers link against the symbols.
Freezing one now means freezing it around a protocol known to be wrong.

## Decision drivers

- Time to a sellable product without a rewrite.
- Decode yield: keep QR detection on OS-native, accelerated frameworks.
- Freedom to change the wire format while it is still improving.
- Not spending engineering capital on platforms nobody has paid for yet.

## Options considered

**Rewrite the core in C now and package it.** Rejected. Pays the full rewrite
cost before the protocol has settled, and moves QR decoding away from the
platform frameworks that currently make it work.

**Phased delivery.** Accepted, as below.

## Decision

### Phase 1 — Instrument, tune, stabilise

Land the throughput work on the existing implementations before any packaging:
measure real frame yield, raise the QR version, implement base45. The protocol
settles first.

### Phase 2 — Ship `LightDBKit` as a Swift XCFramework

`ios/LightDBKit` is already Foundation-only and conformance-tested. Package it
as `LightDBKit.xcframework` with an embedded Ed25519 offline licensing layer,
distributed by SPM `binaryTarget`. This produces a commercial iOS and macOS SDK
without writing a line of C.

### Phase 3 — Extract the C core when demand is real

When an Android, Windows or Rust customer exists, implement the protocol once
in C against the boundary specified in [`spec/lightdb.h`](../../spec/lightdb.h):
**decoded payload strings in, frames out**. The host application decodes QR its
own way.

## Consequences

### Positive

- iOS keeps Vision, so decode yield is unaffected.
- A sellable SDK exists in weeks rather than after a rewrite.
- No ABI is frozen around a protocol still being changed.
- No bundled barcode dependency, so the binary stays small.

### Negative, and accepted

- **Two implementations remain**, so `spec/vectors/` must keep governing them.
  Every protocol change lands twice plus regenerated vectors.
- **Consumers write platform QR glue.** Roughly fifteen lines of Vision or
  ML Kit to produce the strings `lightdb_decoder_ingest` expects. This is the
  deliberate trade: a little integration work in exchange for the best decoder
  on each platform.
- **Phase 3 may never happen**, which is the point — it is contingent on
  demand, not scheduled.

### Licensing: what it does and does not buy

Ed25519 with an embedded public key and offline verification is the right
shape and is what Phase 2 will use. Its limits should be stated plainly so
nobody over-invests in hardening it:

- The public key ships inside the binary. Patching the verification branch is
  minutes of work with a hex editor or Frida.
- The bundle identifier check reads the *host* application's identifier, which
  an attacker controls.
- Expiry is checked against system time, which the user can set backwards, and
  an air-gapped device has no authority to appeal to.

None of this makes it worthless. It makes licensing auditable and
contractually enforceable and stops casual misuse, which is the actual job. It
is a commercial control, not a security boundary.

### Distribution caveat

SPM `binaryTarget` URLs **cannot be authenticated** — SPM will not send
credentials to an arbitrary host. "Private repository URL" does not work as the
original proposal implies. In practice: host the archive publicly and rely on
the licence for control, or use expiring signed URLs and accept the friction.
The archive also needs a `swift package compute-checksum` digest, and slices
for `ios-arm64` plus a universal simulator slice.

## Open questions

Recorded rather than answered, because they affect Phase 3's shape and are
cheaper to resolve before anything is implemented.

**The encoder API does not express a delta.** `lightdb_encoder_create` takes a
whole database blob. But the protocol's entire efficiency is encoding *only
what a given peer lacks*, derived from that peer's version vector. As specified,
every sync would ship the full state. Phase 3 needs the peer's vector to travel
both ways — something like `lightdb_decoder_get_peer_vector()` feeding a
delta-aware encoder constructor. Sketched in `spec/lightdb.h`, not settled.

**"Database" presumes SQLite, which we do not use.** The payload today is a
gzipped JSON CRDT sync message, not a SQLite file. The specification therefore
says `get_payload`, not `get_database`. If SQLite (via the session extension or
cr-sqlite) is later adopted as the storage layer, that is a separate decision
and deserves its own ADR.

**Struct evolution.** `LightDBConfig` and `LightDBDecoderProgress` cross the
ABI by pointer, so adding a field would break existing callers. The
specification puts a `struct_size` first field in each so the library can
version-check what it was handed. Worth confirming before implementation.

**WebAssembly.** If Phase 3 happens, the web app could load the C core as WASM
and retire the TypeScript implementation — removing the duplication this ADR
accepts. That would trade the near-zero-dependency premise for a single core.
Not decided here.
