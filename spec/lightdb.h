/*
 * lightdb C-ABI — TARGET SPECIFICATION, NOT AN IMPLEMENTATION
 * ============================================================
 *
 * Nothing in this repository implements this header. It records the agreed
 * shape of a future `liblightdb` so the boundary can be argued about before
 * anyone writes code against it. See docs/adr/0001-defer-c-core-ship-lightdbkit.md
 * for why extraction is deferred and what has to be true before it starts.
 *
 * The load-bearing decision here is where the boundary sits: this library takes
 * *decoded QR payload strings*, never camera buffers. Apple's Vision and
 * Android's ML Kit decode blurred, angled symbols better than anything we would
 * bundle, are hardware-accelerated, and cost nothing. The hard, valuable part
 * of lightdb is the protocol -- deterministic fountain selection, framing,
 * conflict-free merge -- not barcode detection. Hosts spend ~15 lines of glue
 * and keep the best decoder on their platform.
 *
 * ABI rules this header follows:
 *   - Opaque handles only; no internal layout is ever exposed.
 *   - int32_t returns, never C enums, whose underlying type is
 *     implementation-defined and therefore not ABI-stable.
 *   - The caller allocates every output buffer. The library never hands back
 *     memory the caller must free, so there is no ownership question to get
 *     wrong and no allocator to match across a module boundary.
 *   - Every struct crossing the boundary begins with its own size, so fields
 *     can be added later without breaking already-linked callers.
 */

#ifndef LIGHTDB_H
#define LIGHTDB_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* -------------------------------------------------------------------------- */
/* Status codes                                                               */
/* -------------------------------------------------------------------------- */

#define LIGHTDB_OK                     0
#define LIGHTDB_COMPLETE               1  /* payload fully reconstructed      */
#define LIGHTDB_ERR_INVALID_LICENSE   -1
#define LIGHTDB_ERR_LICENSE_EXPIRED   -2
#define LIGHTDB_ERR_INVALID_PAYLOAD   -3  /* not ours, or failed to parse     */
#define LIGHTDB_ERR_CORRUPT_STATE     -4  /* checksum mismatch after assembly */
#define LIGHTDB_ERR_BUFFER_TOO_SMALL  -5  /* see the two-call pattern below   */
#define LIGHTDB_ERR_INVALID_ARGUMENT  -6
#define LIGHTDB_ERR_UNSUPPORTED_ABI   -7  /* struct_size not recognised       */

/* -------------------------------------------------------------------------- */
/* Versioning and diagnostics                                                 */
/* -------------------------------------------------------------------------- */

/** Packed as (major << 16) | (minor << 8) | patch. Check before anything else. */
uint32_t lightdb_abi_version(void);

/** Protocol version this build speaks, matching spec/PROTOCOL.md. */
uint32_t lightdb_protocol_version(void);

/**
 * Human-readable detail for the calling thread's most recent failure.
 *
 * Thread-local, valid until the next failing call on the same thread. Status
 * codes alone make field diagnosis very hard; this exists so a support ticket
 * can contain something actionable.
 */
const char* lightdb_last_error_message(void);

/* -------------------------------------------------------------------------- */
/* Handles                                                                    */
/* -------------------------------------------------------------------------- */

/** Licence state. Thread-safe; share one across an application. */
typedef struct LightDBEngine LightDBEngine;

/** One inbound transfer. NOT thread-safe; confine each to one queue. */
typedef struct LightDBDecoder LightDBDecoder;

/** One outbound stream. NOT thread-safe; confine each to one queue. */
typedef struct LightDBEncoder LightDBEncoder;

/* -------------------------------------------------------------------------- */
/* Configuration and progress                                                 */
/* -------------------------------------------------------------------------- */

typedef struct {
    /** Set to sizeof(LightDBConfig). Lets the library accept older callers. */
    uint32_t struct_size;

    /** Payload bytes per fountain block, before framing and base45/base64. */
    uint32_t max_block_bytes;

    /** Pinned so every frame in a stream is physically identical in size. */
    uint32_t target_qr_version;

    /** 1 enables base45 over QR alphanumeric mode: ~3% expansion, not ~33%. */
    uint8_t  enable_base45;
} LightDBConfig;

typedef struct {
    /** Set to sizeof(LightDBDecoderProgress) before calling. */
    uint32_t struct_size;

    /** Frames accepted as ours, including redundant ones. */
    uint32_t frames_ingested;

    /** Source blocks recovered so far. */
    uint32_t blocks_solved;

    /** Total needed. Zero until the first frame reveals the session geometry. */
    uint32_t total_blocks_expected;

    /** blocks_solved / total_blocks_expected, or 0 before geometry is known. */
    float    progress_ratio;
} LightDBDecoderProgress;

/* -------------------------------------------------------------------------- */
/* Lifecycle and licensing                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Verify an Ed25519-signed licence offline against the embedded public key.
 *
 * `expected_bundle_id` is supplied by the caller rather than sniffed from the
 * process, because a static library reading its own host's identity gains no
 * security -- the host is exactly what an attacker controls -- while making the
 * library harder to test and to port.
 *
 * This is a commercial control, not a security boundary. See the ADR.
 */
int32_t lightdb_engine_init(
    const char*     license_token_base64,
    const char*     expected_bundle_id,
    LightDBEngine** out_engine
);

void lightdb_engine_destroy(LightDBEngine* engine);

/* -------------------------------------------------------------------------- */
/* Decoder — payload in, assembled bytes out                                  */
/* -------------------------------------------------------------------------- */

/** `config` may be NULL for defaults. */
int32_t lightdb_decoder_create(
    LightDBEngine*        engine,
    const LightDBConfig*  config,
    LightDBDecoder**      out_decoder
);

/**
 * Feed one decoded QR payload, exactly as the platform decoder returned it.
 *
 * Frames may arrive in any order, be duplicated, or be missing; the fountain
 * code does not care. Payloads that are not ours return
 * LIGHTDB_ERR_INVALID_PAYLOAD and are otherwise harmless, so a host may feed
 * everything its camera sees without filtering.
 *
 * @return LIGHTDB_OK while assembling, LIGHTDB_COMPLETE when the payload is
 *         whole and its checksum verified.
 */
int32_t lightdb_decoder_ingest(
    LightDBDecoder* decoder,
    const char*     payload_utf8
);

int32_t lightdb_decoder_get_progress(
    LightDBDecoder*         decoder,
    LightDBDecoderProgress* out_progress
);

/**
 * Copy the assembled payload into caller memory.
 *
 * Two-call pattern: pass out_buffer NULL to learn the size, then call again
 * with a buffer of at least that size. Returns LIGHTDB_ERR_BUFFER_TOO_SMALL if
 * the buffer is short, with *inout_size set to what is required.
 *
 * Named `payload`, not `database`: the bytes are a CRDT sync message, not a
 * SQLite file. If SQLite is ever adopted as the storage layer that is a
 * separate decision.
 */
int32_t lightdb_decoder_get_payload(
    LightDBDecoder* decoder,
    uint8_t*        out_buffer,
    size_t*         inout_size
);

/**
 * Discard progress and wait for a fresh session, without destroying the
 * decoder. Cheaper than a destroy/create cycle when a sender restarts.
 */
int32_t lightdb_decoder_reset(LightDBDecoder* decoder);

void lightdb_decoder_destroy(LightDBDecoder* decoder);

/* -------------------------------------------------------------------------- */
/* Encoder — bytes in, an endless frame sequence out                          */
/* -------------------------------------------------------------------------- */

int32_t lightdb_encoder_create(
    LightDBEngine*       engine,
    const uint8_t*       payload_bytes,
    size_t               payload_size,
    const LightDBConfig* config,
    LightDBEncoder**     out_encoder
);

/**
 * Produce the next frame as a string for the host to render as a QR symbol.
 *
 * The sequence never ends. There is no back-channel, so a sender cannot know
 * when the receiver has enough; a human or a convergence check stops it.
 *
 * Two-call pattern, as above. Frame length is constant for a given
 * configuration, so one sizing call up front is enough.
 */
int32_t lightdb_encoder_next_frame(
    LightDBEncoder* encoder,
    char*           out_str_buffer,
    size_t*         inout_str_size
);

void lightdb_encoder_destroy(LightDBEncoder* encoder);

/* -------------------------------------------------------------------------- */
/* OPEN QUESTION — delta sync                                                 */
/* -------------------------------------------------------------------------- */
/*
 * The encoder above takes a whole payload, which makes every sync a full
 * transfer. That is not how the protocol works: its entire efficiency is
 * sending only the operations a specific peer lacks, derived from that peer's
 * version vector. Without this the C core would be dramatically slower than
 * the Swift and TypeScript implementations it replaces.
 *
 * Closing it needs the peer's vector to travel in both directions, roughly:
 *
 *   int32_t lightdb_decoder_get_peer_vector(
 *       LightDBDecoder* decoder, char* out_buffer, size_t* inout_size);
 *
 *   int32_t lightdb_encoder_create_delta(
 *       LightDBEngine* engine,
 *       const uint8_t* payload_bytes, size_t payload_size,
 *       const char* peer_vector,      // from the call above, or NULL first time
 *       const LightDBConfig* config,
 *       LightDBEncoder** out_encoder);
 *
 * Deliberately not settled here. Resolve it before implementation, not after.
 */

#ifdef __cplusplus
}
#endif

#endif /* LIGHTDB_H */
