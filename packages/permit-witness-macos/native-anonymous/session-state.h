#ifndef PW_SESSION_STATE_H
#define PW_SESSION_STATE_H
#include "session-wire.h"

/* Independent macOS development state machine. NO transport, launch, timer,
 * TLS, callback execution, permit authority, sandbox or process-tree evidence.
 * Semantic reference: bounded-session.js endpoint(), not its FIFO launcher.
 * Native owner thread only. All operations check one local monotonic deadline;
 * callers must call tick to observe expiry while idle (NOT a watchdog).
 * The only key copy owned here is private, wiped at every terminal transition.
 * Caller must wipe its own bootstrap copy. K possession is NOT OS identity. */
enum { PW_SS_PARENT = 1, PW_SS_CHILD = 2, PW_SS_MAX_OPERATIONS = 64,
    PW_SS_MAX_FRAMES = 64, PW_SS_MAX_SESSIONS = 4,
    PW_SS_CAPACITY_LIMIT = 64 * 1024 * 1024,
    PW_SS_BYTE_LIMIT = 8 * PW_SW_MAX_FRAME,
    PW_SS_WIRE_METADATA_ALLOWANCE = 4096 };
enum pw_ss_code { PW_SS_OK, PW_SS_BUSY, PW_SS_INPUT, PW_SS_UNSUPPORTED,
    PW_SS_OWNER, PW_SS_ADMISSION, PW_SS_BUDGET, PW_SS_SYSTEM, PW_SS_SIZE,
    PW_SS_MAC, PW_SS_DOMAIN, PW_SS_SEQUENCE, PW_SS_HANDSHAKE,
    PW_SS_CORRELATION, PW_SS_UNEXPECTED_MESSAGE, PW_SS_OPERATION,
    PW_SS_FRAME_LIMIT, PW_SS_DEADLINE, PW_SS_WRITE, PW_SS_ABORTED,
    PW_SS_DISCONNECTED, PW_SS_DIRECT_EXIT, PW_SS_CLOSED, PW_SS_TOKEN };
enum pw_ss_phase { PW_SS_HELLO, PW_SS_AWAIT_HELLO, PW_SS_HELLO_ACK,
    PW_SS_READY, PW_SS_CLOSING, PW_SS_FINISHED, PW_SS_FAILED };
enum pw_ss_event { PW_SS_NONE, PW_SS_READY_EVENT, PW_SS_REQUEST_EVENT,
    PW_SS_RESPONSE_EVENT, PW_SS_CLOSED_EVENT };
typedef struct pw_ss_root pw_ss_root;
typedef struct pw_ss_session pw_ss_session;
typedef struct {
    uint32_t abi_version;
    size_t struct_bytes;
    enum pw_ss_event event;
    uint32_t request_id;
    uint16_t operation;
    const unsigned char *payload;
    size_t payload_bytes;
} pw_ss_event_v1;
typedef struct {
    size_t sessions_retained, capacity_reserved, sent_reserved, received_charged;
    size_t capacity_limit, byte_limit;
    uint32_t in_sequence, out_sequence, request_id;
    unsigned incoming_frames, outgoing_frames;
    int phase, terminal_code, key_wiped, session_key_holder;
    int execution_authorized, os_identity, tree_exit_proven, watchdog;
} pw_ss_snapshot_v1;

pw_ss_root *pw_ss_root_create_v1(void);
/* Fixed ledger: metadata + every admitted session + every temporary wire
 * frame + every owned result copy charged BEFORE allocation, never refunded.
 * Per output reserve = wire length + 4096 conservative wire metadata allowance.
 * External inbound buffers, caller copies, allocator/OS/JS memory and other
 * roots are excluded. Not RSS or a global/tree budget. Max one writer and one
 * parent request per session. No hidden result queue. */
int pw_ss_create_v1(pw_ss_root *, int role, const unsigned char *key, size_t key_bytes,
    const unsigned char *session, size_t session_bytes, uint64_t deadline_ns,
    const uint16_t *operations, size_t operation_count, unsigned max_frames,
    pw_ss_session **out);
uint64_t pw_ss_now_ns_v1(void);
/* Outbound view is borrowed until write_done/terminal. A monotonically growing
 * token binds completion to THAT frame; stale/duplicate completion is terminal.
 * No "written" assertion proves remote receipt. Caller must report actual local
 * complete write success/failure, only once. View lookup doesn't consume it. */
int pw_ss_outbound_v1(pw_ss_session *, const unsigned char **, size_t *, uint64_t *token);
int pw_ss_write_done_v1(pw_ss_session *, uint64_t token, int success,
    pw_ss_event_v1 *, size_t event_bytes);
/* Complete immutable frame input; length validated here before field access.
 * Wire verifies MAC/domain/seq; state validates handshakes and correlation.
 * REQUEST payload borrows input: the owner must keep that frame immutable
 * through its handler, or make and budget its own copy. RESPONSE payload is a
 * private bounded copy valid until the next response or CLOSE_ACK is received,
 * terminal or root destroy, including when the
 * reply arrives before local request completion. Never exposed on failure.
 * Outputs must be separate aligned writable objects; wrong size is no-write.
 * v1 layouts are fixed: future changes require new type/symbol versions. */
int pw_ss_receive_v1(pw_ss_session *, const unsigned char *, size_t,
    pw_ss_event_v1 *, size_t event_bytes);
int pw_ss_request_v1(pw_ss_session *, uint64_t operation, const unsigned char *, size_t);
/* request/respond copy payload synchronously before returning successfully.
 * Caller may release or modify that payload AFTER the call; during the call
 * it must remain readable and immutable. receive does not take input ownership.
 * Never pass a REQUEST view after its backing transport frame was released. */
int pw_ss_respond_v1(pw_ss_session *, const unsigned char *, size_t);
int pw_ss_close_v1(pw_ss_session *);
int pw_ss_tick_v1(pw_ss_session *);
int pw_ss_abort_v1(pw_ss_session *);
int pw_ss_eof_v1(pw_ss_session *);
/* Mirrors JS directExit(): unexpected outside closing is terminal; notification
 * in closing does NOT prove successful CLOSE or tree exit. No wait implementation. */
int pw_ss_direct_exit_v1(pw_ss_session *);
int pw_ss_inspect_v1(pw_ss_root *, pw_ss_session *, pw_ss_snapshot_v1 *, size_t);
int pw_ss_root_destroy_v1(pw_ss_root *);
const char *pw_ss_code_name_v1(int);
#endif
