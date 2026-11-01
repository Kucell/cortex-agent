#ifndef PW_ANONYMOUS_H
#define PW_ANONYMOUS_H
#include <stddef.h>
#include <stdint.h>

/* Development candidate. Single creating thread; no fd, path, env or PID API.
 * Frame views are borrowed until the next read/cancel. Root owns sessions until
 * destroy; charges NEVER decrease, including after observed direct-child exit. */
typedef struct pw_root pw_root;
typedef struct pw_session pw_session;
enum pw_result {
    PW_OK, PW_AGAIN, PW_UNSUPPORTED, PW_UNSAFE_DEPLOYMENT, PW_ADMISSION,
    PW_SYSTEM, PW_CLOSED, PW_DEADLINE, PW_LENGTH, PW_TRUNCATED, PW_EOF,
    PW_QUOTA, PW_AUTH, PW_BUSY, PW_CANCELLED, PW_OWNER, PW_TRACE_LIMIT, PW_ABI
};
enum { PW_FRAME_MAX = 512, PW_READ_TOTAL = 1024, PW_WRITE_TOTAL = 262144,
       PW_SESSION_MAX = 2, PW_TRACE_MAX = 256 };
/* V2 wire capacity includes the 4-byte session length prefix. The native
 * transport carries opaque bytes; it does not implement/authorize v2 syntax. */
enum { PW_V2_WIRE_MAX = 1048697, PW_V2_BODY_MAX = PW_V2_WIRE_MAX - 4,
       PW_V2_TOTAL = 8 * PW_V2_WIRE_MAX, PW_V2_TRACE_MAX = 16384,
       PW_FRAME_COUNT_MAX = 1024, PW_IO_QUANTUM = 4096 };
enum pw_profile { PW_PROFILE_SMALL, PW_PROFILE_V2, PW_PROFILE_STATE_V2 };
/* STATE_V2 is an additive fixture-only single framing profile used by
 * combined-session. It includes the original u32 header in its owned input
 * buffer. It cannot be launched through the legacy pw_start/handshake API. */
typedef struct {
    size_t credit, phase_remaining, total_remaining, reserved_before_read;
    int result; /* bytes, or -errno; never payload */
} pw_read_trace;
typedef struct {
    uint32_t abi_version;
    size_t struct_bytes;
    size_t sessions, capacity_bytes, received_bytes, sent_bytes;
    size_t root_capacity_bytes, capacity_limit, max_frame_bytes;
    size_t root_metadata_bytes, trace_capacity_bytes;
    size_t read_limit, send_limit, trace_limit, allocation_attempts;
    size_t incoming_frames, outgoing_frames;
    /* Includes bootstrap and full framed writes; never refunded on failure. */
    size_t reserved_send_bytes;
    size_t pending_read_bytes, trace_count;
    unsigned open_fds, close_calls, read_calls, write_calls, write_waits;
    int terminal, direct_exit_observed, direct_exit_status, launch_started;
    int lifecycle_unknown, charges_retained, tree_exit_proven;
    int execution_authorized, authenticated, key_wiped;
    int cleanup_unknown, parent_endpoints_verified;
} pw_snapshot_v2;
enum { PW_SNAPSHOT_ABI_V2 = 2 };

int pw_platform_supported(void);
uint64_t pw_now_ns(void);
pw_root *pw_root_create(void);
/* Trusted compile-time/test caller selects one fixed profile, never arbitrary
 * limits. No production enablement: pw_start still refuses non-fixture builds.
 * V2 callers must be native owners; existing addon is NOT enabled for V2. */
pw_root *pw_root_create_profile(enum pw_profile);
/* Non-fixture builds always refuse: protected code identity is unimplemented. */
int pw_start(pw_root *, uint64_t absolute_deadline_ns, pw_session **);
int pw_handshake_step(pw_session *);
/* Each possible read first checks readiness with nonblocking poll(timeout=0).
 * Idle polling performs NO read and consumes NO trace entry; every actual
 * read, including readiness races/EINTR/EOF, still gets a recorded pre-syscall
 * credit. Only POLLIN/POLLHUP/POLLERR bits are accepted; any other bit also
 * rejects a mixed event. Buffered HUP data is read before EOF is established.
 * Trace/byte/deadline limits remain fail-closed, with no refund or
 * coalescing of evidence. Callers schedule subsequent steps; no retry loop or
 * timer/watchdog is installed here. Short fragmented reads can still exhaust
 * the fixed trace budget. No change to snapshot v2 layout/ABI. */
int pw_read_frame_step(pw_session *, const unsigned char **, size_t *);
int pw_write_frame_begin(pw_session *, const unsigned char *, size_t);
/* begin copies at most the admitted profile's body capacity into owned heap
 * memory. step performs at most one <=4096-byte write, read at most two such
 * reads (header + body). Owner must round-robin sessions, never spin one until
 * completion. Returned read views borrow memory until next read/cancel. */
int pw_write_step(pw_session *);
int pw_cancel(pw_session *);
int pw_observe_direct_exit(pw_session *);
int pw_terminate_direct_child(pw_session *);
/* Unreleased ABI break: the old pw_inspect symbol is intentionally absent.
 * Rebuild ALL callers. v2 layout is fixed; future changes require a new symbol
 * and type. Only exact version AND sizeof(pw_snapshot_v2) are accepted.
 * Mismatch/null output => PW_ABI, no output bytes touched (even on error).
 * The caller must supply genuinely writable, aligned storage of that size;
 * this negotiation cannot validate an address or a dishonest size claim.
 * capacity_bytes = lifetime session-buffer reservations (not RSS).
 * root_capacity_bytes = root metadata + fixed trace reservation, separate from
 * session buffers. These exclude allocator/OS/JS overhead and other roots. */
int pw_inspect_v2(pw_root *, pw_session *, uint32_t abi_version,
    size_t caller_bytes, pw_snapshot_v2 *);
int pw_trace_at(pw_root *, size_t, pw_read_trace *);
/* Refuses while a started child has not been reaped by this root. */
int pw_root_destroy(pw_root *);
const char *pw_result_name(int);
#endif
