#ifndef PW_COMBINED_SESSION_H
#define PW_COMBINED_SESSION_H
#include "anonymous.h"
#include "session-state.h"

/* Independent native DEV fixture composition, not N-API/production identity.
 * Owner creates fixed child, transmits native-only bootstrap, pumps one read
 * and write quantum per call. No API for arbitrary fd/PID/path/spawn/key export.
 * One owner thread per root; round-robin sessions. No timer/watchdog/TLS/tree
 * proof. State CLOSE and observed direct-child exit are separate facts. */
typedef struct pw_cs_root pw_cs_root;
typedef struct pw_cs_session pw_cs_session;
enum { PW_CS_OK, PW_CS_AGAIN, PW_CS_BUSY, PW_CS_TRANSPORT, PW_CS_PROTOCOL,
    PW_CS_CLOSED, PW_CS_INPUT, PW_CS_REFUSED, PW_CS_OWNER };
typedef struct {
    pw_snapshot_v2 transport;
    pw_ss_snapshot_v1 state;
    size_t wrapper_reserved_bytes;
    int error, transport_error, state_error, protocol_closed;
    int state_available, process_rss_measured;
} pw_cs_snapshot_v1;
int pw_cs_root_create_v1(pw_cs_root **);
int pw_cs_start_v1(pw_cs_root *, uint64_t absolute_deadline_ns, pw_cs_session **);
/* One <=4096-byte nonblocking write and <=4100 bytes of nonblocking reads
 * per call (bootstrap uses a separate turn). Frame allocation/copy/MAC are
 * synchronous bounded CPU work up to MAX_FRAME, not hard realtime. Callers
 * round-robin sessions; this is a pump API, not an event loop/watchdog.
 * REQUEST views remain immutable until respond copies them: pump then returns
 * BUSY (while still ticking/waiting). RESPONSE views have state.h lifetime.
 * Completion tokens are private: only actual full transport writes complete
 * state outbound frames. No user-supplied completion or authentication bit. */
int pw_cs_pump_v1(pw_cs_session *, pw_ss_event_v1 *, size_t);
int pw_cs_request_v1(pw_cs_session *, uint64_t operation, const unsigned char *, size_t);
int pw_cs_respond_v1(pw_cs_session *, const unsigned char *, size_t);
int pw_cs_close_v1(pw_cs_session *);
int pw_cs_abort_v1(pw_cs_session *);
int pw_cs_observe_v1(pw_cs_session *);
int pw_cs_terminate_v1(pw_cs_session *);
int pw_cs_inspect_v1(pw_cs_session *, pw_cs_snapshot_v1 *, size_t);
int pw_cs_trace_v1(pw_cs_root *, size_t, pw_read_trace *);
/* Refuses while any created direct child remains unreaped or fd cleanup is
 * unknown. No session/tree admission or capacity refunds on protocol close. */
int pw_cs_root_destroy_v1(pw_cs_root *);

#ifdef PW_ANONYMOUS_STATE_FIXTURE
#ifndef PW_ANONYMOUS_FIXTURE
#error "State composition is a separate fixture build, not production enablement"
#endif
/* Internal fixture bridge only; never returns the key. Child adoption owns
 * ONLY fixed inherited 3/4/5. Before adoption, all three must be open anonymous
 * pipe endpoints with fixed directions; a contract mismatch leaves them all
 * untouched and *out=NULL. After that check ownership transfers as one set:
 * NONBLOCK/configuration/bootstrap failure closes all three. No concurrent
 * fd replacement is allowed by this single-owner child entry contract.
 * Restores CLOEXEC before use; this is not OS identity/authentication. */
int pw_state_start_fixture_v1(pw_root *, pw_ss_root *, uint64_t, pw_session **, pw_ss_session **);
int pw_state_bootstrap_step_fixture_v1(pw_session *);
int pw_state_adopt_fixture_v1(pw_root *, pw_session **);
int pw_state_accept_step_fixture_v1(pw_session *, pw_ss_root *, pw_ss_session **);
int pw_state_read_fixture_v1(pw_session *, const unsigned char **, size_t *);
int pw_state_write_begin_fixture_v1(pw_session *, const unsigned char *, size_t);
int pw_state_write_step_fixture_v1(pw_session *);
/* Child entry only, no launch. Same pump/state/codec as parent. */
int pw_cs_accept_fixture_v1(pw_cs_root *, pw_cs_session **);
int pw_cs_resume_fixture_v1(pw_cs_session *);
#endif
#endif
