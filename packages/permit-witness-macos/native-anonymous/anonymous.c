#include "anonymous.h"
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#ifdef PW_ANONYMOUS_STATE_FIXTURE
#include "combined-session.h"
#endif

#ifdef __APPLE__
#include <CommonCrypto/CommonHMAC.h>
#include <poll.h>
#include <spawn.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#ifdef PW_ANONYMOUS_FIXTURE
#include "fixture-only.h"
#ifndef PW_FIXED_PEER_PATH
#error "A fixed absolute benign fixture path is required"
#endif
#endif
#endif

struct pw_session {
    struct pw_root *root;
    int fds[6], terminal, started, reaped, exit_status, authenticated;
    int bootstrap_closed, key_wiped;
    int cleanup_unknown, endpoints_verified;
    int pid; /* Private direct-child creation record, never caller supplied. */
    uint64_t deadline;
    unsigned close_calls, read_calls, write_calls, write_waits;
    unsigned char bootstrap[56], expected_ack[32];
    unsigned char header[4], *body, *output;
    size_t header_used, body_used, body_length, output_used, output_length;
    size_t write_credit;
    int frame_ready;
    int state_mode;
    size_t bootstrap_used;
    size_t incoming_frames, outgoing_frames;
};
struct pw_root {
    pthread_t owner;
    size_t count, received, sent, reserved_send, pending, traces;
    size_t frame_max, read_limit, send_limit, trace_limit;
    size_t capacity, capacity_limit, allocations;
    int fault;
    int state_profile;
    struct pw_session sessions[PW_SESSION_MAX];
    pw_read_trace *trace;
};

#if defined(PW_ANONYMOUS_FIXTURE) && defined(PW_FIXTURE_SEND_LIMIT)
_Static_assert(PW_FIXTURE_SEND_LIMIT > 0 && PW_FIXTURE_SEND_LIMIT <= PW_WRITE_TOTAL,
    "fixture may only reduce the fixed send limit");
#define SEND_LIMIT PW_FIXTURE_SEND_LIMIT
#else
#define SEND_LIMIT PW_WRITE_TOTAL
#endif
#if defined(PW_ANONYMOUS_FIXTURE) && defined(PW_FIXTURE_V2_READ_LIMIT)
_Static_assert(PW_FIXTURE_V2_READ_LIMIT > 0 && PW_FIXTURE_V2_READ_LIMIT <= PW_V2_TOTAL,"reduce only");
#define V2_READ_LIMIT PW_FIXTURE_V2_READ_LIMIT
#else
#define V2_READ_LIMIT PW_V2_TOTAL
#endif
#if defined(PW_ANONYMOUS_FIXTURE) && defined(PW_FIXTURE_V2_SEND_LIMIT)
_Static_assert(PW_FIXTURE_V2_SEND_LIMIT > 0 && PW_FIXTURE_V2_SEND_LIMIT <= PW_V2_TOTAL,"reduce only");
#define V2_SEND_LIMIT PW_FIXTURE_V2_SEND_LIMIT
#else
#define V2_SEND_LIMIT PW_V2_TOTAL
#endif
#if defined(PW_ANONYMOUS_FIXTURE) && defined(PW_FIXTURE_V2_CAPACITY_LIMIT)
_Static_assert(PW_FIXTURE_V2_CAPACITY_LIMIT > 0 &&
    PW_FIXTURE_V2_CAPACITY_LIMIT <= PW_SESSION_MAX * (2 * PW_V2_BODY_MAX + 4),"reduce only");
#define V2_CAPACITY_LIMIT PW_FIXTURE_V2_CAPACITY_LIMIT
#else
#define V2_CAPACITY_LIMIT (PW_SESSION_MAX * (2 * PW_V2_BODY_MAX + 4))
#endif

uint64_t pw_now_ns(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) return 0;
    return (uint64_t)t.tv_sec * 1000000000ULL + (uint64_t)t.tv_nsec;
}
int pw_platform_supported(void) {
#if defined(__APPLE__) && defined(__aarch64__)
    struct utsname u;
    char version[32]; size_t size = sizeof(version);
    return uname(&u) == 0 && !strcmp(u.release, "27.0.0") &&
        !strcmp(u.machine, "arm64") &&
        sysctlbyname("kern.osproductversion", version, &size, NULL, 0) == 0 &&
        !strcmp(version, "27.0.1");
#else
    return 0;
#endif
}
static int owner(pw_root *r) {
    return r && pthread_equal(r->owner, pthread_self());
}
static int owned(pw_session *s) { return s && owner(s->root); }
static void wipe(void *p, size_t n) {
    volatile unsigned char *v = p;
    while (n--) *v++ = 0;
}
static void close_slot(pw_session *s, size_t i) {
    int fd = s->fds[i];
    if (fd < 0) return;
    s->fds[i] = -1; /* No retry of close(EINTR): never close a recycled number. */
    s->close_calls++;
    if (close(fd)) s->cleanup_unknown = 1;
}
static void wipe_key(pw_session *s) {
    wipe(s->bootstrap, sizeof(s->bootstrap));
    wipe(s->expected_ack, sizeof(s->expected_ack)); s->key_wiped = 1;
}
static int stop(pw_session *s, int code) {
    if (!s->terminal) {
        s->terminal = code;
        for (size_t i = 0; i < 6; i++) close_slot(s, i);
        wipe_key(s);
        // Application data stays charged and owned until root destruction;
        // do not wipe a megabyte on a completion/cancel scheduling turn.
    }
    return s->terminal;
}
static int checkpoint(pw_session *s) {
    if (!owned(s)) return PW_OWNER;
    if (s->terminal) return s->terminal;
    uint64_t now = pw_now_ns();
    if (!now) return stop(s, PW_SYSTEM);
    return now >= s->deadline ? stop(s, PW_DEADLINE) : PW_OK;
}
static int reserve_write(pw_session *s, size_t length) {
    if (length > s->root->send_limit - s->root->reserved_send) return stop(s, PW_QUOTA);
    s->root->reserved_send += length;
    s->write_credit = length;
    return PW_OK;
}
pw_root *pw_root_create(void) {
    return pw_root_create_profile(PW_PROFILE_SMALL);
}
pw_root *pw_root_create_profile(enum pw_profile profile) {
    if (!pw_platform_supported()) return NULL;
    if (profile != PW_PROFILE_SMALL && profile != PW_PROFILE_V2 && profile != PW_PROFILE_STATE_V2) return NULL;
    pw_root *r = calloc(1, sizeof(*r));
    if (!r) return NULL;
    r->owner = pthread_self();
    r->state_profile = profile == PW_PROFILE_STATE_V2;
    r->frame_max = profile != PW_PROFILE_SMALL ? PW_V2_BODY_MAX : PW_FRAME_MAX;
    r->read_limit = profile != PW_PROFILE_SMALL ? V2_READ_LIMIT : PW_READ_TOTAL;
    r->send_limit = profile != PW_PROFILE_SMALL ? V2_SEND_LIMIT : SEND_LIMIT;
    r->trace_limit = profile != PW_PROFILE_SMALL ? PW_V2_TRACE_MAX : PW_TRACE_MAX;
    r->capacity_limit = r->state_profile ? PW_SESSION_MAX * (2 * PW_V2_WIRE_MAX) : profile == PW_PROFILE_V2 ? V2_CAPACITY_LIMIT : PW_SESSION_MAX * (2 * PW_FRAME_MAX + 4);
    // Root metadata and trace storage are a fixed profile overhead, separate
    // from lifetime session buffer capacity. Trace space is admitted before
    // allocation; creation failure returns no root, and cannot start a child.
    r->trace = calloc(r->trace_limit, sizeof(*r->trace));
    if (!r->trace) { free(r); return NULL; }
    return r;
}

#ifdef __APPLE__
static int prepare_pipe(pw_session *s, size_t first) {
    int pair[2];
    /* Supported only on the verified macOS runtime. No pipe()+fcntl fallback:
     * both ends must be CLOEXEC and nonblocking at creation, even if another
     * thread performs a broad inheriting spawn before our next instruction. */
    if (pipe2(pair, O_CLOEXEC | O_NONBLOCK)) return PW_SYSTEM;
    s->fds[first] = pair[0]; s->fds[first + 1] = pair[1];
    for (size_t i = first; i < first + 2; i++) {
        int fd = s->fds[i], flags;
        if (fcntl(fd, F_SETNOSIGPIPE, 1)) return PW_SYSTEM;
        struct stat st;
        flags = fcntl(fd, F_GETFL);
        if (flags < 0 || !(flags & O_NONBLOCK) ||
            (flags & O_ACCMODE) != (i == first ? O_RDONLY : O_WRONLY) ||
            fcntl(fd, F_GETFD) != FD_CLOEXEC || fstat(fd, &st) ||
            !S_ISFIFO(st.st_mode) || st.st_nlink != 0) return PW_SYSTEM;
    }
    return PW_OK;
}
/* Every read, including EAGAIN/EOF, has a fixed, recorded pre-syscall grant.
 * Single owner thread => no concurrent check/use of root allowance. */
static int read_part_on(pw_session *s, size_t slot, unsigned char *buffer, size_t remaining, size_t *got, int eof_ok) {
    int rc = checkpoint(s); if (rc) return rc;
    pw_root *r = s->root;
    if (r->traces == r->trace_limit) return stop(s, PW_TRACE_LIMIT);
    size_t total = r->read_limit - r->received - r->pending;
    size_t credit = remaining < PW_IO_QUANTUM ? remaining : PW_IO_QUANTUM;
    if (credit > total) credit = total;
    if (!credit) return stop(s, PW_QUOTA);
    // No read on an idle pipe: polling the owner must not spend one of the
    // finite per-syscall trace records just to discover EAGAIN. poll never
    // waits and consumes no bytes. Readiness is only a hint: an actual read
    // still needs its grant below, including a raced EAGAIN/EINTR or EOF.
    struct pollfd readiness = { s->fds[slot], POLLIN, 0 };
    int available = poll(&readiness, 1, 0), poll_errno = errno;
    rc = checkpoint(s); if (rc) return rc; // discard late readiness as well
    if (available < 0) return poll_errno == EINTR ? PW_AGAIN : stop(s,PW_SYSTEM);
    if (!available) return PW_AGAIN;
    const unsigned accepted_events = POLLIN | POLLHUP | POLLERR;
    if (((unsigned short)readiness.revents & ~accepted_events) ||
        !((unsigned short)readiness.revents & accepted_events)) return stop(s,PW_SYSTEM);
    r->pending += credit;
    pw_read_trace *trace = &r->trace[r->traces++];
    *trace = (pw_read_trace){ credit, remaining, total, r->pending, 0 };
    s->read_calls++;
    ssize_t n = read(s->fds[slot], buffer, credit);
    int saved = errno;
    trace->result = n < 0 ? -saved : (int)n;
    r->pending -= credit; /* syscall is synchronous, fd always nonblocking */
    if (n > 0) { r->received += (size_t)n; *got = (size_t)n; return PW_OK; }
    if (n == 0) return eof_ok ? PW_EOF : stop(s, s->header_used || s->body_length ? PW_TRUNCATED : PW_EOF);
    if (saved == EAGAIN || saved == EINTR) return PW_AGAIN;
    return stop(s, PW_SYSTEM);
}
static int read_part(pw_session *s, unsigned char *buffer, size_t remaining, size_t *got) {
    return read_part_on(s,2,buffer,remaining,got,0);
}
static int frame_step(pw_session *s, const unsigned char **bytes, size_t *length) {
    int rc = checkpoint(s); if (rc) return rc;
    if (!bytes || !length) return stop(s, PW_SYSTEM);
    *bytes = NULL; *length = 0;
    if (s->frame_ready) {
        s->header_used = s->body_used = s->body_length = 0; s->frame_ready = 0;
    }
    size_t n = 0;
    if (s->header_used < 4) {
        rc = read_part(s, s->header + s->header_used, 4 - s->header_used, &n);
        if (rc) return rc;
        s->header_used += n;
        if (s->header_used != 4) return PW_AGAIN;
        s->body_length = ((size_t)s->header[0] << 24) | ((size_t)s->header[1] << 16) |
            ((size_t)s->header[2] << 8) | s->header[3];
        if (!s->body_length || s->body_length > s->root->frame_max) return stop(s, PW_LENGTH);
        if (s->incoming_frames == PW_FRAME_COUNT_MAX) return stop(s, PW_QUOTA);
        s->incoming_frames++; // counted before body read; failures do not refund
        if(s->state_mode) memcpy(s->body,s->header,4);
    }
    n = 0;
    rc = read_part(s, s->body + (s->state_mode ? 4 : 0) + s->body_used, s->body_length - s->body_used, &n);
    if (rc) return rc;
    s->body_used += n;
    if (s->body_used != s->body_length) return PW_AGAIN;
    s->frame_ready = 1; *bytes = s->body; *length = s->body_length + (s->state_mode ? 4 : 0);
    return checkpoint(s); /* discard late result, even if syscall succeeded */
}
static int write_bytes(pw_session *s, size_t slot, const unsigned char *p, size_t n, size_t *used) {
    int rc = checkpoint(s); if (rc) return rc;
    size_t credit = n < PW_IO_QUANTUM ? n : PW_IO_QUANTUM;
    if (!credit || credit > s->write_credit) return stop(s, PW_SYSTEM);
    s->write_calls++;
    ssize_t count = write(s->fds[slot], p, credit);
    int saved = errno;
    if (count > 0) {
        *used += (size_t)count; s->root->sent += (size_t)count;
        s->write_credit -= (size_t)count; return checkpoint(s);
    }
    if (count < 0 && (saved == EAGAIN || saved == EINTR)) { s->write_waits++; return PW_AGAIN; }
    return stop(s, PW_SYSTEM);
}
#endif

static int start_impl(pw_root *r, uint64_t deadline, pw_session **out, int state_mode) {
    if (out) *out = NULL;
    if (!owner(r)) return PW_OWNER;
    if (!pw_platform_supported()) return PW_UNSUPPORTED;
#if !defined(__APPLE__) || !defined(PW_ANONYMOUS_FIXTURE)
    (void)deadline; (void)state_mode;
    return PW_UNSAFE_DEPLOYMENT;
#else
    if (!out) return PW_SYSTEM;
    if(r->state_profile != !!state_mode) return PW_AUTH;
    uint64_t now = pw_now_ns();
    if (!now || deadline <= now || deadline - now > 5000000000ULL) return PW_DEADLINE;
    if (r->count == PW_SESSION_MAX) return PW_ADMISSION;
    pw_session *s = &r->sessions[r->count++];
    s->root = r; s->deadline = deadline; s->state_mode=state_mode;
    for (size_t i = 0; i < 6; i++) s->fds[i] = -1;
    *out = s; /* admission is retained even if all subsequent setup fails */
    size_t capacity = 2 * r->frame_max + 4 + (state_mode ? 4 : 0);
    if (capacity > r->capacity_limit - r->capacity) return stop(s, PW_ADMISSION);
    r->capacity += capacity; // precharge BOTH buffers, even if first malloc fails
    r->allocations++; s->body = malloc(r->frame_max + (state_mode ? 4 : 0));
    if (!s->body) return stop(s, PW_SYSTEM);
    r->allocations++; s->output = malloc(r->frame_max + 4);
    if (!s->output) return stop(s, PW_SYSTEM);
    if (reserve_write(s, sizeof(s->bootstrap))) return s->terminal;
    for (size_t i = 0; i < 3; i++) {
        if (r->fault == PW_FAULT_PIPE_1 + (int)i || prepare_pipe(s, i * 2)) return stop(s, PW_SYSTEM);
        if (checkpoint(s)) return s->terminal;
    }
    s->endpoints_verified = 1;
    if (r->fault == PW_FAULT_FLAGS) return stop(s, PW_SYSTEM);
    /* Collision-free sources above child targets 3/4/5, retaining CLOEXEC.
     * CLOEXEC_DEFAULT excludes unrelated descriptors even without CLOEXEC. */
    int source[3] = { -1, -1, -1 }, rc = PW_SYSTEM;
    size_t slots[3] = { 0, 3, 4 };
    posix_spawn_file_actions_t actions;
    posix_spawnattr_t attr;
    int actions_ok = 0, attr_ok = 0;
    for (size_t i = 0; i < 3; i++) {
        source[i] = fcntl(s->fds[slots[i]], F_DUPFD_CLOEXEC, 16);
        if (source[i] < 0) goto cleanup;
    }
    if (posix_spawn_file_actions_init(&actions)) goto cleanup;
    actions_ok = 1;
    if (posix_spawnattr_init(&attr)) goto cleanup;
    attr_ok = 1;
    if (posix_spawnattr_setflags(&attr, POSIX_SPAWN_CLOEXEC_DEFAULT)) goto cleanup;
    if (posix_spawn_file_actions_addchdir(&actions, "/")) goto cleanup;
    for (size_t i = 0; i < 3; i++)
        if (posix_spawn_file_actions_adddup2(&actions, source[i], (int)i + 3)) goto cleanup;
    for (size_t i = 0; i < 3; i++)
        if (posix_spawn_file_actions_addclose(&actions, source[i])) goto cleanup;
    if (r->fault == PW_FAULT_ACTIONS || checkpoint(s)) goto cleanup;
    arc4random_buf(s->bootstrap, 48);
    for (size_t i = 0; i < 8; i++) s->bootstrap[48+i] = (unsigned char)(deadline >> (56 - i*8));
    if(!state_mode){
        unsigned char input[77];
        memcpy(input, "PW_ANONYMOUS_DEV_ACK:", 21); memcpy(input + 21, s->bootstrap, 56);
        CCHmac(kCCHmacAlgSHA256, s->bootstrap, 32, input, sizeof(input), s->expected_ack);
        wipe(input, sizeof(input));
    }
    if (checkpoint(s)) goto cleanup;
    if (r->fault == PW_FAULT_SPAWN) goto cleanup;
    char *const argv[] = { (char *)PW_FIXED_PEER_PATH, NULL };
    char *const env[] = { NULL };
    pid_t pid;
    if (posix_spawn(&pid, PW_FIXED_PEER_PATH, &actions, &attr, argv, env)) goto cleanup;
    s->pid = pid; s->started = 1; rc = PW_OK;
cleanup:
    if (attr_ok) posix_spawnattr_destroy(&attr);
    if (actions_ok) posix_spawn_file_actions_destroy(&actions);
    for (size_t i = 0; i < 3; i++) if (source[i] >= 0) {
        if (close(source[i])) s->cleanup_unknown = 1;
        s->close_calls++;
    }
    close_slot(s, 0); close_slot(s, 3); close_slot(s, 4);
    if (rc || s->cleanup_unknown) return stop(s, rc ? rc : PW_SYSTEM);
    return checkpoint(s);
#endif
}
int pw_start(pw_root *r,uint64_t deadline,pw_session **out) { return start_impl(r,deadline,out,0); }
int pw_handshake_step(pw_session *s) {
    int rc = checkpoint(s); if (rc) return rc;
    if(s->state_mode) return stop(s,PW_AUTH);
#ifdef __APPLE__
    if (s->authenticated) return PW_OK;
    if (!s->bootstrap_closed) {
        /* Separate write cursor: no application writes are admitted yet. */
        rc = write_bytes(s, 5, s->bootstrap + s->output_used, 56 - s->output_used, &s->output_used);
        if (rc) return rc;
        if (s->output_used != 56) return PW_AGAIN;
        close_slot(s, 5); s->bootstrap_closed = 1; s->output_used = 0;
        if (s->cleanup_unknown) return stop(s, PW_SYSTEM);
        wipe(s->bootstrap, sizeof(s->bootstrap));
    }
    const unsigned char *p; size_t n;
    rc = frame_step(s, &p, &n); if (rc) return rc;
    unsigned diff = (n != 32);
    if (n == 32) for (size_t i = 0; i < 32; i++) diff |= p[i] ^ s->expected_ack[i];
    if (diff) return stop(s, PW_AUTH);
    s->authenticated = 1; wipe_key(s); return PW_OK;
#else
    return stop(s, PW_UNSUPPORTED);
#endif
}
int pw_read_frame_step(pw_session *s, const unsigned char **p, size_t *n) {
    int rc = checkpoint(s); if (rc) return rc;
    if (!s->authenticated || s->state_mode) return stop(s, PW_AUTH);
#ifdef __APPLE__
    return frame_step(s, p, n);
#else
    (void)p; (void)n; return stop(s, PW_UNSUPPORTED);
#endif
}
int pw_write_frame_begin(pw_session *s, const unsigned char *p, size_t n) {
    int rc = checkpoint(s); if (rc) return rc;
    if (!s->authenticated || s->state_mode) return stop(s, PW_AUTH);
    if (s->output_length) return PW_BUSY;
    if (!p || !n || n > s->root->frame_max) return stop(s, PW_LENGTH);
    if (s->outgoing_frames == PW_FRAME_COUNT_MAX) return stop(s, PW_QUOTA);
    /* Admit the complete header + payload before copying or issuing any write.
     * Short writes, EAGAIN, cancellation and syscall errors never refund it. */
    if (reserve_write(s, n + 4)) return s->terminal;
    s->outgoing_frames++;
    s->output[0] = (unsigned char)(n >> 24); s->output[1] = (unsigned char)(n >> 16);
    s->output[2] = (unsigned char)(n >> 8); s->output[3] = (unsigned char)n;
    memcpy(s->output + 4, p, n); s->output_length = n + 4; s->output_used = 0;
    return PW_OK;
}
int pw_write_step(pw_session *s) {
    int rc = checkpoint(s); if (rc) return rc;
    if (!s->authenticated || s->state_mode) return stop(s, PW_AUTH);
    if (!s->output_length) return PW_OK;
#ifdef __APPLE__
    rc = write_bytes(s, 1, s->output + s->output_used, s->output_length - s->output_used, &s->output_used);
    if (rc) return rc;
    if (s->output_used != s->output_length) return PW_AGAIN;
    s->output_used = s->output_length = 0;
    return PW_OK;
#else
    return stop(s, PW_UNSUPPORTED);
#endif
}
int pw_cancel(pw_session *s) { return owned(s) ? stop(s, PW_CANCELLED) : PW_OWNER; }
int pw_observe_direct_exit(pw_session *s) {
    if (!owned(s)) return PW_OWNER;
    if (s->reaped || !s->started) return PW_OK;
#ifdef __APPLE__
    int status; pid_t pid = waitpid(s->pid, &status, WNOHANG);
    if (!pid) return PW_AGAIN;
    if (pid < 0) return errno == EINTR ? PW_AGAIN : PW_SYSTEM;
    s->reaped = 1; s->exit_status = status; return PW_OK;
#else
    return PW_UNSUPPORTED;
#endif
}
int pw_terminate_direct_child(pw_session *s) {
    if (!owned(s)) return PW_OWNER;
    int rc = pw_observe_direct_exit(s);
    if (rc != PW_AGAIN) return rc;
    /* A child not reaped by us cannot have its PID recycled. Other waiters in
     * this process are outside this single-owner development contract. */
    return kill(s->pid, SIGKILL) == 0 ? PW_OK : PW_SYSTEM;
}
int pw_inspect_v2(pw_root *r, pw_session *s, uint32_t version, size_t bytes, pw_snapshot_v2 *out) {
    // Validate before ANY output access, including errors. Never truncate or
    // grow a layout in place: old buffers must not see a new sizeof write.
    if (version != PW_SNAPSHOT_ABI_V2 || bytes != sizeof(*out) || !out) return PW_ABI;
    if (!owner(r) || !out || (s && s->root != r)) return PW_OWNER;
    memset(out, 0, sizeof(*out));
    out->abi_version = PW_SNAPSHOT_ABI_V2; out->struct_bytes = sizeof(*out);
    out->sessions = r->count; out->capacity_bytes = r->capacity;
    out->root_capacity_bytes = sizeof(*r) + r->trace_limit * sizeof(*r->trace);
    out->root_metadata_bytes = sizeof(*r);
    out->trace_capacity_bytes = r->trace_limit * sizeof(*r->trace);
    out->capacity_limit = r->capacity_limit; out->max_frame_bytes = r->frame_max;
    out->read_limit = r->read_limit; out->send_limit = r->send_limit; out->trace_limit = r->trace_limit;
    out->allocation_attempts = r->allocations;
    out->received_bytes = r->received; out->sent_bytes = r->sent;
    out->reserved_send_bytes = r->reserved_send;
    out->pending_read_bytes = r->pending; out->trace_count = r->traces;
    out->charges_retained = 1;
    if (s) {
        for (size_t i = 0; i < 6; i++) out->open_fds += s->fds[i] >= 0;
        out->close_calls = s->close_calls; out->read_calls = s->read_calls;
        out->write_calls = s->write_calls;
        out->write_waits = s->write_waits; out->terminal = s->terminal;
        out->launch_started = s->started; out->direct_exit_observed = s->reaped;
        out->direct_exit_status = s->exit_status;
        out->lifecycle_unknown = s->started && !s->reaped;
        out->authenticated = s->authenticated; out->key_wiped = s->key_wiped;
        out->cleanup_unknown = s->cleanup_unknown;
        out->parent_endpoints_verified = s->endpoints_verified;
        out->incoming_frames = s->incoming_frames; out->outgoing_frames = s->outgoing_frames;
    }
    return PW_OK;
}
int pw_trace_at(pw_root *r, size_t index, pw_read_trace *out) {
    if (!owner(r)) return PW_OWNER;
    if (!out || index >= r->traces) return PW_LENGTH;
    *out = r->trace[index]; return PW_OK;
}
int pw_root_destroy(pw_root *r) {
    if (!owner(r)) return PW_OWNER;
    for (size_t i = 0; i < r->count; i++)
        if (r->sessions[i].started && !r->sessions[i].reaped) return PW_BUSY;
    for (size_t i = 0; i < r->count; i++) stop(&r->sessions[i], PW_CLOSED);
    for (size_t i = 0; i < r->count; i++)
        if (r->sessions[i].cleanup_unknown) return PW_SYSTEM;
    for (size_t i = 0; i < r->count; i++) {
        pw_session *s = &r->sessions[i];
        if (s->body) { wipe(s->body,r->frame_max + (s->state_mode ? 4 : 0)); free(s->body); }
        if (s->output) { wipe(s->output,r->frame_max + 4); free(s->output); }
    }
    wipe(r->trace,r->trace_limit * sizeof(*r->trace)); free(r->trace);
    wipe(r, sizeof(*r)); free(r); return PW_OK;
}
const char *pw_result_name(int rc) {
    static const char *const names[] = { "OK", "AGAIN", "UNSUPPORTED", "UNSAFE_DEPLOYMENT", "ADMISSION",
        "SYSTEM", "CLOSED", "DEADLINE", "LENGTH", "TRUNCATED", "EOF", "QUOTA", "AUTH", "BUSY",
        "CANCELLED", "OWNER", "TRACE_LIMIT", "ABI" };
    return rc >= 0 && (size_t)rc < sizeof(names)/sizeof(names[0]) ? names[rc] : "UNKNOWN";
}
#ifdef PW_ANONYMOUS_STATE_FIXTURE
static int make_state(pw_session *s,pw_ss_root *root,int role,pw_ss_session **out) {
    const uint16_t ops[]={1,2,3};
    return pw_ss_create_v1(root,role,s->bootstrap,32,s->bootstrap+32,16,s->deadline,ops,3,64,out);
}
int pw_state_start_fixture_v1(pw_root *r,pw_ss_root *state_root,uint64_t deadline,pw_session **out,pw_ss_session **state) {
    if(state)*state=NULL;if(!state)return PW_SYSTEM;
    int rc=start_impl(r,deadline,out,1);if(rc)return rc;
    rc=make_state(*out,state_root,PW_SS_PARENT,state);
    return rc?stop(*out,PW_SYSTEM):PW_OK;
}
int pw_state_bootstrap_step_fixture_v1(pw_session *s) {
    int rc=checkpoint(s);if(rc)return rc;if(!s->state_mode)return stop(s,PW_AUTH);
    if(s->bootstrap_closed)return PW_OK;
    rc=write_bytes(s,5,s->bootstrap+s->bootstrap_used,56-s->bootstrap_used,&s->bootstrap_used);if(rc)return rc;
    if(s->bootstrap_used!=56)return PW_AGAIN;
    close_slot(s,5);s->bootstrap_closed=1;wipe_key(s);
    return s->cleanup_unknown?stop(s,PW_SYSTEM):checkpoint(s);
}
int pw_state_adopt_fixture_v1(pw_root *r,pw_session **out) {
    if(out)*out=NULL;if(!owner(r)||!out)return PW_OWNER;
    if(!r->state_profile||r->count==PW_SESSION_MAX)return PW_ADMISSION;
    const int numbers[]={3,4,5};const size_t slots[]={2,1,0};
    // Establish the fixed anonymous-endpoint adoption contract without taking
    // ownership or changing ANY descriptor. A wrong/missing/type/direction
    // endpoint means this may be an unrelated process: do not close its fds.
    // Single native owner must not concurrently replace these fixed numbers.
    for(size_t i=0;i<3;i++) {
        int fd=numbers[i],flags=fcntl(fd,F_GETFL);struct stat st;
        if(flags<0||(flags&O_ACCMODE)!=(fd==4?O_WRONLY:O_RDONLY)||
           fstat(fd,&st)||!S_ISFIFO(st.st_mode)||st.st_nlink)return PW_SYSTEM;
    }
    pw_session *s=&r->sessions[r->count++];s->root=r;s->state_mode=1;
    for(size_t i=0;i<6;i++)s->fds[i]=-1;
    s->deadline=pw_now_ns()+5000000000ULL;*out=s;
    // Contract established: transfer ALL endpoints before fallible validation
    // or configuration. stop() must close the entire set even at index zero.
    for(size_t i=0;i<3;i++)s->fds[slots[i]]=numbers[i];
    for(size_t i=0;i<3;i++) {
        int fd=numbers[i],flags=fcntl(fd,F_GETFL);struct stat st;
        if(flags<0||!(flags&O_NONBLOCK)||(flags&O_ACCMODE)!=(fd==4?O_WRONLY:O_RDONLY)||
           fstat(fd,&st)||!S_ISFIFO(st.st_mode)||st.st_nlink)return stop(s,PW_SYSTEM);
        if(fcntl(fd,F_SETFD,FD_CLOEXEC)||fcntl(fd,F_SETNOSIGPIPE,1))return stop(s,PW_SYSTEM);
    }
    size_t capacity=2*(r->frame_max+4);
    if(capacity>r->capacity_limit-r->capacity)return stop(s,PW_ADMISSION);
    r->capacity+=capacity;r->allocations++;s->body=malloc(r->frame_max+4);
    if(!s->body)return stop(s,PW_SYSTEM);
    r->allocations++;s->output=malloc(r->frame_max+4);
    if(!s->output)return stop(s,PW_SYSTEM);
    return PW_OK;
}
int pw_state_accept_step_fixture_v1(pw_session *s,pw_ss_root *r,pw_ss_session **out) {
    int rc=checkpoint(s);if(rc)return rc;if(!out||!s->state_mode)return stop(s,PW_SYSTEM);
    if(s->bootstrap_closed)return PW_OK;
    size_t got=0;
    if(s->bootstrap_used<56){
        rc=read_part_on(s,0,s->bootstrap+s->bootstrap_used,56-s->bootstrap_used,&got,0);
        if(rc)return rc;s->bootstrap_used+=got;if(s->bootstrap_used<56)return PW_AGAIN;
        uint64_t deadline=0;for(size_t i=0;i<8;i++)deadline=(deadline<<8)|s->bootstrap[48+i];
        uint64_t now=pw_now_ns();if(deadline<=now||deadline-now>5000000000ULL)return stop(s,PW_DEADLINE);
        s->deadline=deadline;
    }
    unsigned char extra;
    rc=read_part_on(s,0,&extra,1,&got,1);
    if(rc==PW_AGAIN)return rc;
    if(rc==PW_OK)return stop(s,PW_LENGTH); // an actual extra bootstrap byte
    if(rc!=PW_EOF)return rc; // preserve SYSTEM/QUOTA/TRACE_LIMIT/DEADLINE
    close_slot(s,0);
    if(s->cleanup_unknown)return stop(s,PW_SYSTEM);
    rc=make_state(s,r,PW_SS_CHILD,out);s->bootstrap_closed=1;wipe_key(s);
    return rc?stop(s,PW_SYSTEM):PW_OK;
}
int pw_state_read_fixture_v1(pw_session *s,const unsigned char **p,size_t *n) {
    int rc=checkpoint(s);if(rc)return rc;
    if(!s->state_mode||!s->bootstrap_closed)return stop(s,PW_AUTH);
    return frame_step(s,p,n);
}
int pw_state_write_begin_fixture_v1(pw_session *s,const unsigned char *p,size_t n) {
    int rc=checkpoint(s);if(rc)return rc;
    if(!s->state_mode||!s->bootstrap_closed)return stop(s,PW_AUTH);
    if(s->output_length)return PW_BUSY;
    if(!p||n<PW_SW_OVERHEAD||n>PW_V2_WIRE_MAX)return stop(s,PW_LENGTH);
    size_t length=((size_t)p[0]<<24)|((size_t)p[1]<<16)|((size_t)p[2]<<8)|p[3];
    if(length!=n-4)return stop(s,PW_LENGTH);
    if(s->outgoing_frames==PW_FRAME_COUNT_MAX)return stop(s,PW_QUOTA);
    if(reserve_write(s,n))return s->terminal;
    // This already includes its single u32 length prefix: NEVER wrap it again.
    memcpy(s->output,p,n);s->output_length=n;s->output_used=0;s->outgoing_frames++;return PW_OK;
}
int pw_state_write_step_fixture_v1(pw_session *s) {
    int rc=checkpoint(s);if(rc)return rc;
    if(!s->state_mode||!s->bootstrap_closed)return stop(s,PW_AUTH);
    if(!s->output_length)return PW_OK;
    rc=write_bytes(s,1,s->output+s->output_used,s->output_length-s->output_used,&s->output_used);if(rc)return rc;
    if(s->output_used<s->output_length)return PW_AGAIN;
    s->output_used=s->output_length=0;return PW_OK;
}
#endif
#ifdef PW_ANONYMOUS_FIXTURE
int pw_fixture_fail_at(pw_root *r, int fault) {
    if (!owner(r)) return PW_OWNER;
    if (r->count || fault < PW_FAULT_NONE || fault > PW_FAULT_SPAWN) return PW_BUSY;
    r->fault = fault; return PW_OK;
}
int pw_fixture_resume_reader(pw_session *s) {
    if (!owned(s)) return PW_OWNER;
    if (!s->started || s->reaped) return PW_CLOSED;
    return kill(s->pid, SIGUSR1) == 0 ? PW_OK : PW_SYSTEM;
}
#endif
