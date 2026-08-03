# CLAUDE.md

Guidance for Claude Code working in this repository.

`lightdb` is a [Boba](https://github.com/sholtomaud/boba) app: a local-first
database that syncs between devices **over light** — one screen displays an
animated QR stream, the other reads it with a camera. No internet, no Bluetooth,
no radio.

---

## 1. The rule that overrides everything else

**Write the failing test first. Run it. Watch it fail. Then write the code.**

This codebase is mostly arithmetic that is invisible when wrong: Galois field
multiplication, Reed-Solomon remainders, QR capacity tables, fountain degree
distributions, CRDT merge order. A bug here does not throw — it produces a QR
code no scanner reads, or a database that silently diverges. Tests are the only
feedback loop that exists.

Do not write implementation code before there is a test that fails without it.
If you catch yourself about to, stop and write the test.

---

## 1a. There are now two implementations

The web app (TypeScript, `src/`) and an iOS receiver (Swift, `ios/`) both
implement the same optical protocol. They share no code — they share
`spec/vectors/`.

**`spec/PROTOCOL.md` is normative.** If you change anything that affects what a
seed selects, what a frame looks like, or how a payload is encoded:

1. change it in TypeScript,
2. `make vectors` to regenerate `spec/vectors/`,
3. bump `PROTOCOL_VERSION` in *both* `src/optical/frame.ts` and
   `ios/LightDBKit/Sources/LightDBKit/Frame.swift`,
4. make the Swift side agree,

all in the same commit. Regenerating vectors to make a test pass is a protocol
change, not a fix.

The specific hazard is floating point. `Math.log` / `Foundation.log` are
*not* required to be correctly rounded, so the two languages can differ in the
last ULP — and near a distribution boundary that flips a degree, changes the
block subset, and breaks every transfer while both suites stay green. That is
why `protocolLog` exists and why the degree distribution is quantised to
integer thresholds. Do not replace either with a library call.

---

## 2. Toolchain — containerised, never the host

**Never run `npm`, `npx` or `node` directly.** There is no host toolchain, and
inventing one will produce results that do not match CI.

| Command | What it does |
| --- | --- |
| `make image` | Build the dev image (`node:26-slim` + Chromium). Once per clone. |
| `make install` | `npm install` inside the container |
| `make test-unit` | `node --test test/*.test.ts` ← **your inner loop** |
| `make lint` | eslint |
| `make dev` | Vite dev server on :5173 |
| `make test` | Playwright e2e |
| `make build-app` | Vite production build |
| `make vectors` | Regenerate `spec/vectors/` from the TypeScript implementation |

Node 26 with native TypeScript type stripping. No compile step.

**The container rule applies to the web app.** Xcode cannot run in a container
— not this one, not any — so the iOS targets are the documented exception and
run against the host toolchain:

| Command | What it does |
| --- | --- |
| `make test-ios` | `swift test` in `ios/LightDBKit` — the conformance suite |
| `make build-ios` | `xcodebuild` the SwiftUI app for the simulator |

`make build-ios` needs Xcode's **iOS platform component** installed
(Xcode → Settings → Components), not just the SDK stubs. Without it
`xcodebuild` reports no eligible destinations for any iOS target, simulator
included, and the error unhelpfully names a physical device.

`make test-unit` takes seconds. Run it constantly — after every red step, after
every green step, before every claim that something works.

---

## 3. The TDD loop

### Red

Write the test in `test/<module>.test.ts`. Name it as a claim about behaviour,
not a description of a function:

```ts
// bad
test('rsRemainder works', ...)

// good
test('Reed-Solomon codewords are divisible by the generator', ...)
```

Run `make test-unit`. **Confirm it fails, and that it fails for the reason you
expect.** A test that passes before the implementation exists is testing
nothing.

### Green

Write the least code that passes. Do not generalise ahead of a test.

### Refactor

Tidy with the test still green. Run `make test-unit` again.

### Before you say it works

```sh
make lint && make test-unit
```

If you touched components, routing, the service worker or anything in the DOM,
also `make test`. Never report a change as working on the strength of having
written it.

---

## 4. What a good test looks like here

Prefer tests that check a **property** over tests that check a remembered value.
Properties catch transcription errors; remembered constants often *are* the
transcription error.

The three highest-value patterns already in this repo:

**Mathematical invariants.** `test/qr-encode.test.ts` asserts that data
concatenated with its Reed-Solomon check symbols is exactly divisible by the
generator polynomial. That is the defining property of an RS codeword — it
cannot pass if the divisor or the remainder loop is wrong.

**Table re-derivation.** The same file re-derives the published QR byte-mode
capacities (17 bytes at 1-L, 2953 at 40-L, …) from the two block-structure
tables. A single mistyped digit in either table fails this.

**Round trips through the real seam.** `test/optical-roundtrip.test.ts` runs
fountain → frame → base64 → QR → back, with frames deliberately dropped. That is
the boundary where a sync would actually arrive corrupted.

Also always test: idempotence (apply twice, expect no change), commutativity
(reverse the order, expect the same state), and rejection (bad input returns
null or throws, rather than silently producing garbage).

---

## 5. Boba conventions

### Components

One directory per component, three files:

```
src/components/thing-page/
  thing-page.ts     class extending BaseComponent
  thing-page.html   markup
  thing-page.css    scoped styles, :host is rewritten to the tag name
```

```ts
import { BaseComponent } from '../../core/base-component.ts';
import template from './thing-page.html?raw';
import style from './thing-page.css?raw';

export class ThingPageComponent extends BaseComponent {
  static tagName = 'thing-page';

  constructor() {
    super(template, style);
  }

  init() {
    // called from connectedCallback, after markup is in the DOM
    this.delegate('click', '#some-btn', () => this.doThing());
  }
}

if (!customElements.get(ThingPageComponent.tagName)) {
  customElements.define(ThingPageComponent.tagName, ThingPageComponent);
}
```

- Markup and CSS live in files, not template literals.
- `init()`, not `connectedCallback()`. The base class calls it.
- `this.delegate(...)` for events — listeners survive `innerHTML` updates.
- Tag names are kebab-case. The router resolves a route's component by
  convention from `src/components/<tag>/<tag>.ts`, so the tag **is** the
  directory name.
- Register routes in `src/main.ts`.

### TypeScript settings that will bite you

- **Mandatory `.ts` extensions on every import** (`nodenext` resolution).
- **`erasableSyntaxOnly`** — no enums, no namespaces, no parameter properties
  (`constructor(private x)`). Use `const X = {...} as const` plus a union type,
  and assign fields explicitly in the constructor body.
- **`verbatimModuleSyntax`** — type-only imports need `import type`.
- `strict` is on.

### Styling

Plain CSS with variables from `src/styles/variables.css`. **No Tailwind** —
Boba's template ships it, this app deliberately does not. Do not reintroduce a
CSS framework.

---

## 6. Load-bearing invariants

Change these carelessly and everything still compiles, lints and mostly passes,
while transfers silently stop working.

**`selectBlocks()` must stay bit-for-bit deterministic — now across two
languages.** Sender and receiver never exchange which blocks a frame combines;
both derive it from the frame's 32-bit seed. Changing the PRNG, the degree
distribution, or the ordering breaks every transfer while single-sided unit
tests keep passing. `test/conformance.test.ts` and the Swift suite are what
protect you, and the result is sorted precisely so agreement does not depend on
two languages iterating a hash set alike.

**The frame header is a wire format.** Change it and bump `PROTOCOL_VERSION` in
`src/optical/frame.ts`. `decodeFrame` rejects unknown versions — that is what
stops a new build from mis-parsing an old one.

**Payloads travel as base64url on purpose.** Every browser QR decoder returns a
*string*, and the charset assumed for QR byte mode varies by platform
(ISO-8859-1 on some, UTF-8 on others). Do not "optimise away" the 33% expansion
without first solving that. The real fix is base45 over QR alphanumeric mode
(~3% instead of 33%); see README.

**`versionVector()` reports the highest *contiguous* sequence per actor**, not
the maximum. A gap must cause a resend, not silent data loss. This is
deliberate; do not "fix" it.

**QR block-structure tables.** `ECC_CODEWORDS_PER_BLOCK` and
`NUM_ERROR_CORRECTION_BLOCKS` in `src/optical/qr-encode.ts` are the only
irreducible tables. Everything else is computed. If you edit them,
`test/qr-encode.test.ts` is the thing standing between you and unscannable
symbols.

---

## 7. Layout

```
src/
├── components/      one folder per component (.ts + .html + .css)
├── core/            BaseComponent, Store, Router — from Boba
├── optical/         the transport
│   ├── galois.ts        GF(256) + Reed-Solomon
│   ├── qr-encode.ts     minimal byte-mode QR generator, versions 1-40
│   ├── fountain.ts      LT codes: soliton, encoder, peeling decoder
│   ├── frame.ts         24-byte wire header + CRC-32
│   ├── base64.ts        base64url
│   ├── transmitter.ts   canvas render loop
│   └── scanner.ts       camera + pluggable QR decoder
├── db/
│   ├── crdt.ts          LWW map, op logs, version vectors
│   ├── idb.ts           IndexedDB persistence
│   └── sync.ts          two-pass protocol
├── store/           app-level Store instance
├── styles/          global CSS + variables
└── main.ts          routes, link interception, SW registration

public/              manifest.json, sw.js, icon.svg — copied verbatim by Vite
test/                node --test unit tests
e2e/                 Playwright specs
```

`public/` is served at the root. `index.html` links `manifest.json`, and
`sw.js` precaches it — those paths must agree.

---

## 8. Platform reality

`BarcodeDetector` is effectively Chrome-and-Edge only. Safari and every browser
on iOS lack it, Firefox lacks it, and **Brave ships Chromium but disables it**
as a fingerprinting surface — so "is it Chromium?" is not a usable test.

`ensureQrDecoder()` in `src/optical/scanner.ts` resolves this at runtime: native
if present, otherwise a dynamic import of zxing-wasm. Always go through it.
Never gate UI on `hasNativeQrDecoding()` alone — that is the bug that left the
camera button permanently disabled on iOS and Brave. Gate on the promise
resolving.

Three things about the wasm are load-bearing:

- **It is bundled locally, never from a CDN.** zxing-wasm's default
  `locateFile` points at jsDelivr; `src/optical/zxing-decoder.ts` overrides it
  to a Vite `?url` asset. An e2e test asserts no request leaves the origin.
- **`script-src` needs `'wasm-unsafe-eval'`** in the `index.html` CSP or the
  module cannot instantiate.
- **The import must stay dynamic** so browsers with native decoding never
  download 450 KB they will not use.

---

## 9. Working style

- Read `AGENTS.md` and `README.md` before large changes. The README documents
  *why* the awkward decisions are the way they are.
- Do not add runtime dependencies. Boba's premise is near-zero deps and this app
  holds to it — the QR generator, fountain codec and CRDT are all hand-written
  for that reason. A new dependency needs a stated argument.
- When a test fails, read the failure before changing anything. These modules
  fail in specific, informative ways.
- Report honestly. If `make test-unit` fails, say so and show the output. If you
  skipped `make test`, say that too.
