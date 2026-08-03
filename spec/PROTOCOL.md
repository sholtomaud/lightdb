# lightdb optical protocol, version 2

Normative specification. Any implementation that reproduces the vectors in
`spec/vectors/` will interoperate with any other; anything else will not.

The whole protocol rests on one property: **sender and receiver never exchange
which blocks a frame combines.** Both derive it from the frame's 32-bit seed.
Every requirement below exists to make that derivation identical across
languages, platforms and floating-point libraries.

---

## 1. Frame layout

24-byte header, big-endian, followed by exactly `blockSize` payload bytes.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 2 | magic, `0x4C 0x44` (`"LD"`) |
| 2 | 1 | protocol version, currently `2` |
| 3 | 1 | flags |
| 4 | 4 | session id |
| 8 | 4 | total payload length in bytes, before block padding |
| 12 | 2 | block size |
| 14 | 2 | block count |
| 16 | 4 | fountain seed for this frame |
| 20 | 4 | CRC-32 of the complete reassembled payload |
| 24 | … | fountain-coded block |

Flags: bit 0 set means the payload was gzipped before block splitting.

A receiver **must** reject a frame whose magic or version does not match. Every
frame carries the full session geometry, so a receiver joining mid-stream needs
no handshake.

### 1.1 CRC-32

Standard CRC-32 (IEEE 802.3), polynomial `0xEDB88320` reflected, initial value
`0xFFFFFFFF`, final XOR `0xFFFFFFFF`. The check value for `"123456789"` is
`0xCBF43926`.

### 1.2 Transport encoding

Frames are encoded as **unpadded base64url** (`A-Z a-z 0-9 - _`) before being
placed in a QR symbol in byte mode.

This costs 33% expansion and is deliberate. Every browser QR decoder returns a
*string*, never bytes, and the charset assumed for QR byte mode varies by
platform — ISO-8859-1 on some, UTF-8 on others. A native implementation that
can read raw bytes must still encode and decode base64url, or it will not
interoperate with the web implementation.

---

## 2. The PRNG

xorshift32, seeded with the frame's 32-bit seed.

```
state = seed as uint32
if state == 0: state = 0x9E3779B9      // xorshift32 has a fixed point at zero

next():
  state ^= state << 13   (uint32)
  state ^= state >> 17   (logical shift)
  state ^= state << 5    (uint32)
  return state
```

All operations are on unsigned 32-bit integers with wrapping. Implementations
must confirm against `vectors/prng.json`.

---

## 3. Natural logarithm

**Implementations must not use the platform `log` function.**

Its precision is implementation-defined — neither IEEE-754 nor the C standard
requires correct rounding — so JavaScript engines and platform libms can differ
in the last unit in the last place. Anywhere that difference crosses a
distribution boundary, two implementations select different block subsets from
the same seed. Every transfer between them then fails, while both
implementations' own test suites stay green.

The protocol therefore defines its own:

```
LN2 = 0.6931471805599453          // IEEE-754 double 0x3FE62E42FEFA39EF
LOG_TERMS = 20

protocolLog(x):                   // x finite and > 0, else error
  exponent = 0
  mantissa = x
  while mantissa >= 2: mantissa /= 2; exponent += 1
  while mantissa <  1: mantissa *= 2; exponent -= 1

  z  = (mantissa - 1) / (mantissa + 1)
  z2 = z * z
  term = z
  sum  = z
  for i in 1 ..< LOG_TERMS:
    term = term * z2
    sum  = sum + term / (2*i + 1)

  return exponent * LN2 + 2 * sum
```

Why this is reproducible: range reduction by powers of two is exact in binary
floating point, and the series uses only IEEE-754 addition, subtraction,
multiplication and division, which *are* required to be correctly rounded. With
`mantissa` in `[1, 2)`, `|z| < 1/3`, so 20 terms is far past converged for
double precision.

All arithmetic is IEEE-754 binary64. `Math.sqrt` is correctly rounded by
IEEE-754 and may be used directly.

---

## 4. Degree distribution

Robust soliton over degrees `1..k`, with `c = 0.05` and `delta = 0.05`,
evaluated in binary64 and then **quantised to unsigned 32-bit thresholds**.

```
solitonThresholds(k, c = 0.05, delta = 0.05) -> uint32[k+1]

  p[1] = 1 / k
  for i in 2...k: p[i] = 1 / (i * (i - 1))

  r     = c * protocolLog(k / delta) * sqrt(k)
  pivot = max(1, floor(k / r))

  for i in 1 ..< pivot where i <= k:
    p[i] += r / (i * k)
  if pivot <= k:
    p[pivot] += (r * protocolLog(r / delta)) / k

  total = sum of p[1...k]

  running = 0
  for i in 1...k:
    running   += p[i] / total
    scaled     = round(running * 0xFFFFFFFF)
    t[i]       = min(0xFFFFFFFF, max(t[i-1], scaled))
  t[k] = 0xFFFFFFFF        // saturate

  return t
```

`t[0]` is unused and zero. `round` is round-half-away-from-zero on a
non-negative value, matching JavaScript `Math.round` over this range.

Quantising here is the point: it confines every floating-point decision to
table construction, and makes the per-frame sampling step pure integer
comparison.

---

## 5. Block selection

```
selectBlocks(seed, numBlocks, thresholds) -> ascending index list

  rng = xorshift32(seed)

  // degree
  u = rng()
  degree = first i in 1...k where u <= thresholds[i], else k
  degree = min(degree, numBlocks)

  // indices
  picked = empty set
  guard  = degree * 64 + 64
  while picked.count < degree and guard > 0:
    picked.insert(floor((rng() * numBlocks) / 0x100000000))
    guard -= 1

  for i = 0, 1, 2, … while picked.count < degree:
    picked.insert(i % numBlocks)

  return picked sorted ascending
```

Two requirements that are easy to miss:

- **Index derivation is multiply-shift, not modulo.** `rng() * numBlocks` is
  computed in a type wide enough to hold a 64-bit product (or in binary64,
  which represents it exactly for these magnitudes), then divided by 2^32.
  Modulo would bias toward low indices, and the two are not interchangeable.
- **The result is sorted.** Insertion order into a hash set is not portable, and
  implementations must agree on the sequence, not merely the set.

---

## 6. Encoding and decoding

A payload of `totalLength` bytes is split into `numBlocks = ceil(totalLength /
blockSize)` blocks, the last zero-padded. `totalLength` tells the receiver where
to cut.

**Encode** for a seed: XOR together the blocks named by `selectBlocks`.

**Decode**: standard peeling. Substitute known blocks out of each incoming
equation; when one reduces to a single unknown, solve it and cascade through
every pending equation that references it. Reassembly is complete when all
`numBlocks` are known; verify `crc32` against the header before accepting.

Frames may arrive in any order, be duplicated, or be missing. Recovery
typically needs 5–15% more frames than there are blocks.

---

## 7. Conformance vectors

`spec/vectors/` is the contract. Every implementation must reproduce:

| File | Covers |
| --- | --- |
| `prng.json` | xorshift32 output sequences |
| `log.json` | `protocolLog` at specified inputs, as exact bit patterns |
| `thresholds.json` | soliton tables for several `k` |
| `selection.json` | seed + block count → ascending indices |
| `frames.json` | header fields + payload → exact encoded bytes |
| `crc32.json` | CRC-32 of specified inputs |

Floating-point values are stored as **hexadecimal bit patterns** of the
underlying binary64, not decimal text, so a conformance failure is unambiguous
rather than a rounding argument.

Regenerate with `make vectors` after any deliberate protocol change, and bump
the protocol version in the same commit.
