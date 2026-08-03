# AGENTS.md — instructions for AI agents

This is a [Boba](https://github.com/sholtomaud/boba) app. Read that repo's
conventions first; this file only records where `lightdb` differs and what is
easy to get wrong here.

## 1. What this is

`lightdb` is a local-first database that syncs between two devices over an
**optical** channel: one screen displays an animated QR stream, the other reads
it with a camera. No internet, no Bluetooth, no radio of any kind.

## 2. Toolchain

Everything runs in a container. **Do not run `npm` or `node` on the host.**

| Command | What it does |
| --- | --- |
| `make image` | Build the dev image (`node:26-slim` + Chromium) |
| `make install` | `npm install` inside the container |
| `make dev` | Vite dev server on :5173 |
| `make test-unit` | `node --test test/*.test.ts` |
| `make test` | Playwright e2e |
| `make lint` | eslint |
| `make build-app` | Vite production build |

Node 26, native TypeScript type stripping, no compile step.

## 3. Directory structure

```
src/
├── components/      one folder per component: .ts + .html + .css
├── core/            BaseComponent, Store, Router — from Boba
├── optical/         the transport: QR, fountain codes, framing, camera
├── db/              CRDT, IndexedDB, sync protocol
├── store/           app-level Store instance
└── styles/          global CSS + variables
public/              manifest.json, sw.js, icon.svg (copied verbatim by Vite)
test/                node --test unit tests
e2e/                 Playwright specs
```

## 4. Conventions that bite

- **Mandatory `.ts` extensions on every import.** `nodenext` resolution.
- **`erasableSyntaxOnly` is on.** No enums, no namespaces, no parameter
  properties (`constructor(private x)`). Use `const X = {...} as const` and
  assign fields explicitly.
- **`verbatimModuleSyntax` is on.** Type-only imports need `import type`.
- HTML and CSS are imported with `?raw` and passed to `super()`. Keep them in
  separate files — do not inline template literals.
- Component tag names are kebab-case, declared as `static tagName`, and
  registered behind an `if (!customElements.get(...))` guard.
- The router loads components by convention from
  `src/components/<tag>/<tag>.ts`. A route's component name *is* its directory.
- **No Tailwind.** Boba's template ships it; this app uses plain CSS with
  variables in `src/styles/variables.css`. Do not reintroduce a CSS framework.

## 5. Things that are load-bearing

- **`selectBlocks()` in `src/optical/fountain.ts` must stay bit-for-bit
  deterministic.** The sender and receiver never exchange which blocks a frame
  combines — they both derive it from the frame's 32-bit seed. Changing the
  PRNG, the degree distribution, or even the iteration order silently breaks
  every transfer while all unit tests that only exercise one side still pass.
- **The frame header is a wire format.** If you change it, bump
  `PROTOCOL_VERSION` in `src/optical/frame.ts`. `decodeFrame` rejects unknown
  versions, which is what stops a new build from mis-parsing an old one.
- **Payloads go over the wire as base64url**, because every browser QR decoder
  returns a *string* and the charset assumed for QR byte mode is not portable.
  Do not "optimise" this away without solving that first (see README).
- **Version vectors are deliberately conservative** — `versionVector()` reports
  the highest *contiguous* sequence per actor, so a gap causes a resend rather
  than silent data loss. Do not change it to report the maximum.
- **`test/qr-encode.test.ts` re-derives the published QR capacity figures** from
  the two block-structure tables. If you edit those tables, that test is the
  thing standing between you and symbols no scanner can read.

## 6. Before pushing

All of these must pass:

```
make install
make lint
make test-unit
make test
```
