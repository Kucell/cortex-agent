#ifndef PW_SESSION_WIRE_H
#define PW_SESSION_WIRE_H
#include <stddef.h>
#include <stdint.h>

/* Standalone codec, NOT a session/transport/TLS/authorization implementation.
 * Sole byte-layout reference: permit-witness-bounded-session-wire.js.
 * Keys are 32-byte synthetic session keys, never permit signing keys.
 * Only verified macOS 27.0.1 arm64 is enabled. No OS identity is established. */
enum { PW_SW_KEY_BYTES = 32, PW_SW_SESSION_BYTES = 16, PW_SW_BINDING_BYTES = 32,
       PW_SW_HEADER_BYTES = 62, PW_SW_TAG_BYTES = 32, PW_SW_OVERHEAD = 98,
       PW_SW_MAX_FRAME = 1048697, PW_SW_MAX_PAYLOAD = PW_SW_MAX_FRAME - PW_SW_OVERHEAD,
       PW_SW_MAX_ENCODINGS = 16, PW_SW_ABI_V1 = 1 };
enum pw_sw_result { PW_SW_OK, PW_SW_INPUT, PW_SW_SIZE, PW_SW_ABI, PW_SW_UNSUPPORTED,
    PW_SW_OWNER, PW_SW_BUDGET, PW_SW_SYSTEM, PW_SW_MAC, PW_SW_DOMAIN,
    PW_SW_SEQUENCE, PW_SW_CORRELATION };
/* Wide input scalars allow rejection BEFORE narrowing, unlike JS assignment
 * to u8 slots. Codec checks widths only; message-type/direction allowlists and
 * HELLO/REQUEST/CLOSE policy belong to a future session owner. */
typedef struct {
    uint64_t direction, type, seq, request_id, operation;
    unsigned char session[PW_SW_SESSION_BYTES], binding[PW_SW_BINDING_BYTES];
} pw_sw_fields_v1;
typedef struct {
    uint32_t abi_version;
    size_t struct_bytes;
    int valid;
    pw_sw_fields_v1 fields;
    const unsigned char *payload;
    size_t payload_bytes;
    unsigned char digest[32]; // SHA-256 of the complete wire, as JS decode returns
} pw_sw_decoded_v1;
typedef struct {
    size_t reserved_bytes, capacity_limit, encoding_attempts, allocation_attempts;
} pw_sw_account_v1;
typedef struct pw_sw_budget pw_sw_budget;
typedef struct pw_sw_frame pw_sw_frame;

int pw_sw_platform_supported_v1(void);
/* Each root has a fixed capacity for four maximum encoded allocations (frame
 * metadata included) and 16 admitted attempts. Charges never refund, even on
 * malloc failure. Root and encoded frames are single creating-thread owned.
 * A new budget is a new ledger; no global/RSS/process-tree bound is claimed. */
pw_sw_budget *pw_sw_budget_create_v1(void);
int pw_sw_budget_inspect_v1(pw_sw_budget *, size_t caller_bytes, pw_sw_account_v1 *);
int pw_sw_budget_destroy_v1(pw_sw_budget *);
/* *out is NULL on any failure. Frame storage remains owned by the budget until
 * destroy. Caller key, fields and payload are borrowed only during this call.
 * Inputs must be real readable ranges, nonoverlapping with output locations. */
int pw_sw_encode_v1(pw_sw_budget *, const unsigned char *key, size_t key_bytes,
    const pw_sw_fields_v1 *, size_t fields_bytes,
    const unsigned char *payload, size_t payload_bytes, pw_sw_frame **out);
const unsigned char *pw_sw_frame_view_v1(pw_sw_frame *, size_t *frame_bytes);
/* Complete-frame verification, zero heap allocation. Requires exact total
 * length and checks HMAC before version/reserved/domain/correlation fields.
 * All fields in expected MUST match; payload is authenticated opaque bytes.
 * On failure correctly-sized out is all-zero (valid=0, payload=NULL). Bad output
 * size returns PW_SW_ABI without touching it. Borrowed payload view lives only
 * as long as the unmodified input frame. Caller provides writable aligned out.
 * v1 types/layouts are fixed: future layout changes require new symbols/types. */
int pw_sw_verify_v1(const unsigned char *key, size_t key_bytes,
    const pw_sw_fields_v1 *expected, size_t expected_bytes,
    const unsigned char *frame, size_t frame_bytes,
    pw_sw_decoded_v1 *out, size_t caller_bytes);
const char *pw_sw_result_name_v1(int);
#endif
