# Architecture Decision Records

Decisions that are expensive to reverse, and the reasoning available at the
time. An ADR is not documentation of how the system works — `README.md` and
`spec/PROTOCOL.md` do that. It is a record of *why* a fork in the road was
taken, so a later reader can tell a deliberate choice from an accident.

Write one when a decision constrains future work: a wire format, a public
boundary, a dependency, a platform commitment. Do not write one for anything
a test could capture instead.

Records are immutable once accepted. If a decision is reversed, add a new ADR
that supersedes it and mark the old one — the wrong turn is often the most
useful part of the history.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-defer-c-core-ship-lightdbkit.md) | Defer the C core, ship LightDBKit, fix the ABI boundary at decoded payloads | Accepted |

## Decisions made before this record existed

These predate the practice and are captured in code and prose rather than as
ADRs. Listed so their absence does not read as oversight:

- **Two implementations governed by conformance vectors** rather than one
  shared core — see `spec/PROTOCOL.md` and `spec/vectors/`.
- **base64url over QR byte mode**, accepting 33% expansion, because browser QR
  decoders return strings with a platform-dependent charset — see README.
- **A hand-written LWW-map CRDT** rather than a diff or a database engine,
  because a one-way channel cannot support a conversation.
- **A specified `protocolLog`** instead of the platform's, because `Math.log`
  and `libm` may differ in the last ULP and silently break cross-language
  block selection.
