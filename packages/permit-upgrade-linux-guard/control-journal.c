#define _GNU_SOURCE
#include "control-journal.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/magic.h>
#include <linux/openat2.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <unistd.h>

/* Canonical LE wire: magic, seq/gen/attempt, event, binding, predecessor,
 * evidence, zero reserved space, SHA256 of first 992 bytes. Never raw structs. */
enum { HASH_AT = PCJ_WIRE_BYTES - 32, BIND_AT = 40, PREV_AT = 672, EVID_AT = 704 };
struct pcj {
    int fd, poisoned, model, owner_acquired;
    pid_t process;
    struct pg_identity identity;
    struct pcj_binding binding;
    struct pcj_state state;
    uint64_t interrupted_generation;
    uint64_t validated_generation;
    uint64_t reserved_generation;
};

static int fail(struct pcj_result *r, int error) {
    if (!r->error) r->error = error;
    errno = r->error;
    return -1;
}
static int close_one(int fd, struct pcj_result *r) {
    if (close(fd) == 0) return 0;
    r->close_error = errno;
    return fail(r, errno);
}
static void put64(unsigned char *p, uint64_t n) {
    for (int i = 0; i < 8; i++) { p[i] = (unsigned char)n; n >>= 8; }
}
static uint64_t get64(const unsigned char *p) {
    uint64_t n = 0;
    for (int i = 7; i >= 0; i--) n = (n << 8) | p[i];
    return n;
}
static int nonzero(const unsigned char *p, size_t n) {
    for (size_t i = 0; i < n; i++) if (p[i]) return 1;
    return 0;
}
static int digest(const unsigned char *wire, unsigned char *out) {
    unsigned int size = 0;
    if (EVP_Digest(wire, HASH_AT, out, &size, EVP_sha256(), NULL) != 1 || size != 32) {
        errno = EIO; return -1;
    }
    return 0;
}
static int opened(int fd, const char *name, uint64_t flags) {
    struct open_how how = { .flags = flags | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK,
        .mode = (flags & O_CREAT) ? 0600 : 0,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV };
    return (int)syscall(SYS_openat2, fd, name, &how, sizeof(how));
}
static int directory(struct pcj *j) {
    struct stat s;
    struct statfs f;
    if (fstat(j->fd, &s) || fstatfs(j->fd, &f)) return -1;
    if (!S_ISDIR(s.st_mode) || s.st_dev != j->identity.device ||
        s.st_ino != j->identity.inode || s.st_uid != j->identity.owner ||
        s.st_nlink == 0 || (s.st_mode & 07777) != 0700 ||
        (!j->model && s.st_uid != 0)) { errno = ESTALE; return -1; }
    if (f.f_type != EXT4_SUPER_MAGIC && f.f_type != XFS_SUPER_MAGIC &&
        f.f_type != BTRFS_SUPER_MAGIC && !(j->model && f.f_type == TMPFS_MAGIC)) {
        errno = EOPNOTSUPP; return -1;
    }
    return 0;
}
static int valid_binding(const struct pcj_binding *b) {
    size_t n = strnlen(b->upgrade_id, sizeof(b->upgrade_id));
    if (!n || n == sizeof(b->upgrade_id) || b->old_present > 1 ||
        b->old_size > PCJ_BYTES || b->target_size == 0 || b->target_size > PCJ_BYTES ||
        (!b->old_present && b->old_size) || !nonzero(b->context_digest, 32)) return 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)b->upgrade_id[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '_')) return 0;
    }
    return 1;
}
static void bind_wire(unsigned char *w, const struct pcj_binding *b) {
    memcpy(w + BIND_AT, b->upgrade_id, strlen(b->upgrade_id));
    memcpy(w + 104, b->context_digest, 32);
    put64(w + 136, b->old_present); put64(w + 144, b->old_size); put64(w + 152, b->target_size);
    memcpy(w + 160, b->old_bytes, b->old_size);
    memcpy(w + 416, b->target_bytes, b->target_size);
}
_Static_assert(416 + PCJ_BYTES == PREV_AT, "binding precedes predecessor");

static int transition(struct pcj *j, uint64_t gen, enum pcj_event event,
                      const unsigned char *evidence) {
    struct pcj_state *s = &j->state;
    if (!gen || s->head.sequence >= PCJ_MAX_RECORDS) { errno = EOVERFLOW; return -1; }
    if (event == PCJ_OWNER) {
        if (s->complete || gen <= s->head.owner_generation) { errno = ESTALE; return -1; }
        if (s->head.owner_generation) j->interrupted_generation = s->head.owner_generation;
        s->head.owner_generation = gen; s->eligible = 0; j->validated_generation = 0;
        s->incomplete = 1;
        return 0;
    }
    if (gen != s->head.owner_generation) { errno = ESTALE; return -1; }
    if (event < PCJ_INCOMPLETE || event > PCJ_DELIVERY_UNKNOWN ||
        (s->complete && event != PCJ_DELIVERY_UNKNOWN)) { errno = EPERM; return -1; }
    if ((event == PCJ_ELIGIBLE || event == PCJ_REVALIDATED || event == PCJ_STAMP_CONFIRMED ||
         event == PCJ_REPORT_CONFIRMED || event == PCJ_COMPLETE) && !nonzero(evidence, 32)) {
        errno = EINVAL; return -1;
    }
    switch (event) {
    case PCJ_INCOMPLETE:
        s->incomplete = 1; s->eligible = 0; j->interrupted_generation = gen;
        j->validated_generation = 0; break;
    case PCJ_ELIGIBLE:
        if (s->attempt || j->interrupted_generation || s->eligible) goto denied;
        s->eligible = 1; j->validated_generation = gen; break;
    case PCJ_REVALIDATED:
        if (!j->interrupted_generation || gen <= j->interrupted_generation || s->eligible) goto denied;
        s->eligible = 1; j->validated_generation = gen; break;
    case PCJ_CALL_POSSIBLE:
        if (!s->eligible || s->stamp == PCJ_STAMP_KNOWN || s->attempt == UINT64_MAX) goto denied;
        s->attempt++; s->stamp = PCJ_STAMP_UNKNOWN; s->eligible = 0;
        s->report_confirmed = 0; j->interrupted_generation = gen; break;
    case PCJ_STAMP_CONFIRMED:
        if (!s->attempt || s->stamp != PCJ_STAMP_UNKNOWN || j->validated_generation != gen) goto denied;
        s->stamp = PCJ_STAMP_KNOWN; s->eligible = 0; break;
    case PCJ_REPORT_CONFIRMED:
        if (s->stamp != PCJ_STAMP_KNOWN || s->report_confirmed || j->validated_generation != gen) goto denied;
        s->report_confirmed = 1; break;
    case PCJ_COMPLETE:
        if (s->stamp != PCJ_STAMP_KNOWN || !s->report_confirmed || j->validated_generation != gen) goto denied;
        s->complete = 1; s->incomplete = 0; s->eligible = 0; break;
    case PCJ_DELIVERY_UNKNOWN: s->delivery_unknown = 1; break;
    default: goto denied;
    }
    return 0;
denied: errno = EPERM; return -1;
}
static void name_for(char *name, uint64_t n) {
    (void)snprintf(name, 32, "r-%020llu", (unsigned long long)n);
}
static int stable(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
        a->st_size == b->st_size && a->st_uid == b->st_uid && a->st_mode == b->st_mode &&
        a->st_nlink == b->st_nlink && a->st_mtim.tv_sec == b->st_mtim.tv_sec &&
        a->st_mtim.tv_nsec == b->st_mtim.tv_nsec && a->st_ctim.tv_sec == b->st_ctim.tv_sec &&
        a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}
static int read_wire(struct pcj *j, int fd, const char *name, unsigned char *w) {
    struct stat before, after, named;
    if (fstat(fd, &before)) return -1;
    if (!S_ISREG(before.st_mode) || before.st_nlink != 1 || before.st_uid != j->identity.owner ||
        (before.st_mode & 07777) != 0600 || before.st_size != PCJ_WIRE_BYTES ||
        before.st_dev != j->identity.device) { errno = EBADMSG; return -1; }
    size_t at = 0;
    while (at < PCJ_WIRE_BYTES) {
        ssize_t n = pread(fd, w + at, PCJ_WIRE_BYTES - at, (off_t)at);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { if (!n) errno = EIO; return -1; }
        at += (size_t)n;
    }
    unsigned char extra;
    ssize_t n;
    do { n = pread(fd, &extra, 1, PCJ_WIRE_BYTES); } while (n < 0 && errno == EINTR);
    if (n != 0) { if (n > 0) errno = EBADMSG; return -1; }
    if (fstat(fd, &after) || fstatat(j->fd, name, &named, AT_SYMLINK_NOFOLLOW)) return -1;
    if (!stable(&before, &after) || !stable(&after, &named)) { errno = ESTALE; return -1; }
    return 0;
}
static int count_records(struct pcj *j, uint64_t *count, struct pcj_result *r) {
    int fd = opened(j->fd, ".", O_RDONLY | O_DIRECTORY);
    if (fd < 0) return fail(r, errno);
    DIR *dir = fdopendir(fd);
    if (!dir) { int error = errno; close_one(fd, r); return fail(r, error); }
    *count = 0;
    errno = 0;
    struct dirent *e;
    int error = 0;
    while ((e = readdir(dir))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        if (++*count > PCJ_MAX_RECORDS || strlen(e->d_name) != 22 || strncmp(e->d_name, "r-", 2)) {
            error = EBADMSG; break;
        }
        for (size_t i = 2; i < 22; i++) if (e->d_name[i] < '0' || e->d_name[i] > '9') error = EBADMSG;
        if (error) break;
        errno = 0;
    }
    if (!error) error = errno;
    /* closedir owns exactly one close; never retry it. */
    if (closedir(dir)) { r->close_error = errno; if (!error) error = errno; }
    return error ? fail(r, error) : 0;
}
static int replay_one(struct pcj *j, uint64_t i, int sync_record, struct pcj_result *r) {
        char name[32]; name_for(name, i);
        int fd = opened(j->fd, name, O_RDONLY);
        if (fd < 0) return fail(r, errno);
        unsigned char w[PCJ_WIRE_BYTES], expected[PCJ_WIRE_BYTES] = {0}, sum[32];
        int error = read_wire(j, fd, name, w) ? errno : 0;
        if (!error && sync_record && fsync(fd)) error = errno;
        if (error) fail(r, error);
        if (close_one(fd, r) && !error) error = r->error;
        if (error) return fail(r, error);
        memcpy(expected, "PCJR0001", 8); bind_wire(expected, &j->binding);
        memcpy(expected + 8, w + 8, 32);
        memcpy(expected + PREV_AT, j->state.head.digest, 32);
        memcpy(expected + EVID_AT, w + EVID_AT, 32);
        if (digest(expected, sum)) return fail(r, errno);
        memcpy(expected + HASH_AT, sum, 32);
        uint64_t gen = get64(w + 16), event = get64(w + 32);
        if (get64(w + 8) != i || event > PCJ_DELIVERY_UNKNOWN || memcmp(w, expected, sizeof(w)))
            return fail(r, EBADMSG);
        if (transition(j, gen, (enum pcj_event)event, w + EVID_AT)) return fail(r, EBADMSG);
        if (get64(w + 24) != j->state.attempt) return fail(r, EBADMSG);
        j->state.head.sequence = i; memcpy(j->state.head.digest, sum, 32);
    return 0;
}
static int replay(struct pcj *j, struct pcj_result *r) {
    uint64_t count;
    if (count_records(j, &count, r)) return -1;
    for (uint64_t i = 1; i <= count; i++) if (replay_one(j, i, 0, r)) return -1;
    return 0;
}
int pcj_open(int fd, struct pg_identity id, int model, const struct pcj_binding *binding,
             const struct pcj_head *checkpoint, struct pcj **out, struct pcj_result *r) {
    if (!r) { errno = EINVAL; return -1; }
    *r = (struct pcj_result){0};
    if (out) *out = NULL;
    if (!out || !binding || !checkpoint || !valid_binding(binding) || (model != 0 && model != 1))
        return fail(r, EINVAL);
    struct pcj *j = calloc(1, sizeof(*j));
    if (!j) return fail(r, errno);
    j->identity = id; j->model = model; j->process = getpid(); j->binding = *binding;
    j->state.delivery_unknown = 1;
    j->fd = opened(fd, ".", O_RDONLY | O_DIRECTORY);
    if (j->fd < 0) { int error = errno; free(j); return fail(r, error); }
    int error = 0;
    if (directory(j) || flock(j->fd, LOCK_EX | LOCK_NB) || directory(j) || replay(j, r)) error = errno;
    if (!error && (j->state.head.sequence != checkpoint->sequence ||
        j->state.head.owner_generation != checkpoint->owner_generation ||
        memcmp(j->state.head.digest, checkpoint->digest, 32))) error = ESTALE;
    if (!error) { *out = j; return 0; }
    fail(r, error); close_one(j->fd, r); free(j); errno = r->error; return -1;
}
int pcj_snapshot(const struct pcj *j, struct pcj_state *out) {
    if (!j || !out || j->process != getpid() || j->poisoned) { errno = EPERM; return -1; }
    *out = j->state; return 0;
}
int pcj_record(struct pcj *j, uint64_t gen, enum pcj_event event,
               const unsigned char evidence[32], struct pcj_result *r) {
    if (!r) { errno = EINVAL; return -1; }
    *r = (struct pcj_result){0};
    if (!j || j->poisoned || j->process != getpid()) return fail(r, EPERM);
    /* A reopened process can observe a checkpoint but cannot resume its owner.
     * Replaying historical OWNER records never grants this live handle ownership. */
    if (!j->owner_acquired && event != PCJ_OWNER) return fail(r, ESTALE);
    if (!j->owner_acquired && j->reserved_generation && gen != j->reserved_generation)
        return fail(r, ESTALE);
    unsigned char proof[32] = {0};
    if (evidence) memcpy(proof, evidence, 32);
    struct pcj next = *j;
    if (transition(&next, gen, event, proof)) return fail(r, errno);
    if (event == PCJ_OWNER) next.owner_acquired = 1;
    if (directory(j)) { j->poisoned = 1; return fail(r, errno); }
    unsigned char wire[PCJ_WIRE_BYTES] = {0}, actual[PCJ_WIRE_BYTES];
    memcpy(wire, "PCJR0001", 8); put64(wire + 8, j->state.head.sequence + 1);
    put64(wire + 16, gen); put64(wire + 24, next.state.attempt); put64(wire + 32, event);
    bind_wire(wire, &j->binding); memcpy(wire + PREV_AT, j->state.head.digest, 32);
    memcpy(wire + EVID_AT, proof, 32);
    if (digest(wire, wire + HASH_AT)) return fail(r, errno);
    char name[32]; name_for(name, j->state.head.sequence + 1);
    r->outcome = PCJ_WRITE_UNKNOWN; j->poisoned = 1;
    int fd = opened(j->fd, name, O_RDWR | O_CREAT | O_EXCL);
    if (fd < 0) return fail(r, errno);
    size_t at = 0;
    int error = 0;
    while (at < sizeof(wire)) {
        ssize_t n = pwrite(fd, wire + at, sizeof(wire) - at, (off_t)at);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { error = n < 0 ? errno : EIO; break; }
        at += (size_t)n;
    }
    if (!error && fsync(fd)) error = errno;
    if (!error && read_wire(j, fd, name, actual)) error = errno;
    if (!error && memcmp(actual, wire, sizeof(wire))) error = EBADMSG;
    if (!error && fsync(j->fd)) error = errno;
    if (!error && directory(j)) error = errno;
    if (error) fail(r, error);
    close_one(fd, r);
    if (r->error) { errno = r->error; return -1; }
    next.state.head.sequence++; memcpy(next.state.head.digest, wire + HASH_AT, 32);
    *j = next; r->outcome = PCJ_SYNC_OBSERVED;
    return 0;
}
int pcj_close(struct pcj **owned, struct pcj_result *r) {
    if (!r) { errno = EINVAL; return -1; }
    *r = (struct pcj_result){0};
    if (!owned || !*owned) return fail(r, EINVAL);
    struct pcj *j = *owned; *owned = NULL;
    int fd = j->fd; free(j);
    return close_one(fd, r);
}

struct pcj_recovery {
    struct pcj *journal;
    struct pcj_anchor anchor;
    uint64_t next_generation, max_tail;
    struct pcj_recovery_view view;
    unsigned char request[PCJ_RECOVERY_REQUEST_BYTES];
    int prepared;
};
static int same_head(const struct pcj_head *a, const struct pcj_head *b) {
    return a->sequence == b->sequence && a->owner_generation == b->owner_generation &&
        !memcmp(a->digest, b->digest, 32);
}
static void reset_replay(struct pcj *j) {
    j->state = (struct pcj_state){.delivery_unknown = 1};
    j->interrupted_generation = j->validated_generation = 0;
    j->owner_acquired = 0;
}
static int classify(struct pcj_recovery *c, int sync_records, struct pcj_result *r) {
    struct pcj *j = c->journal;
    c->view = (struct pcj_recovery_view){.kind = PCJ_TAIL_PREFIX_UNPROVEN};
    reset_replay(j);
    uint64_t count;
    if (directory(j) || count_records(j, &count, r)) return fail(r, errno);
    c->view.records = count;
    if (count < c->anchor.head.sequence) return 0;
    if (!c->anchor.head.sequence) {
        struct pcj_head empty = {0};
        if (!same_head(&c->anchor.head, &empty)) return 0;
        c->view.prefix_verified = 1;
    }
    uint64_t end = count;
    if (count - c->anchor.head.sequence > c->max_tail)
        end = c->anchor.head.sequence; /* Do not examine or adopt an unbounded tail. */
    for (uint64_t i = 1; i <= end; i++) {
        c->view.observed = j->state;
        char name[32]; name_for(name, i);
        struct stat st;
        if (fstatat(j->fd, name, &st, AT_SYMLINK_NOFOLLOW)) {
            if (errno != ENOENT) return fail(r, errno);
            c->view.kind = PCJ_TAIL_INVALID; c->view.bad_sequence = i; return 0;
        }
        if (S_ISREG(st.st_mode) && st.st_size >= 0 && st.st_size < PCJ_WIRE_BYTES) {
            c->view.kind = i > c->anchor.head.sequence ? PCJ_TAIL_TORN : PCJ_TAIL_PREFIX_UNPROVEN;
            c->view.bad_sequence = i; return 0;
        }
        if (replay_one(j, i, sync_records, r)) {
            int error = r->error;
            c->view.bad_sequence = i;
            if (r->close_error || (error != EBADMSG && error != ELOOP && error != ENOENT))
                return -1;
            *r = (struct pcj_result){0};
            c->view.kind = i > c->anchor.head.sequence ? PCJ_TAIL_INVALID : PCJ_TAIL_PREFIX_UNPROVEN;
            return 0;
        }
        c->view.observed = j->state;
        if (i == c->anchor.head.sequence) {
            if (!same_head(&j->state.head, &c->anchor.head)) return 0;
            c->view.prefix_verified = 1;
        }
    }
    c->view.observed = j->state;
    if (!c->view.prefix_verified) return 0;
    if (end != count) { c->view.kind = PCJ_TAIL_OVER_BOUND; return 0; }
    c->view.kind = PCJ_TAIL_COMPLETE;
    return 0;
}
int pcj_recovery_open(int fd, struct pg_identity id, int model,
                      const struct pcj_binding *binding, const struct pcj_anchor *anchor,
                      uint64_t next_generation, uint64_t max_tail,
                      struct pcj_recovery **out, struct pcj_recovery_view *view, struct pcj_result *r) {
    if (!r) { errno = EINVAL; return -1; }
    *r = (struct pcj_result){0};
    if (out) *out = NULL;
    if (view) *view = (struct pcj_recovery_view){0};
    if (!out || !view || !binding || !anchor || !valid_binding(binding) ||
        (model != 0 && model != 1) || !max_tail || max_tail > PCJ_RECOVERY_LIMIT ||
        anchor->head.sequence > PCJ_MAX_RECORDS || anchor->revision == UINT64_MAX ||
        !next_generation || next_generation <= anchor->fence_generation ||
        next_generation <= anchor->head.owner_generation) return fail(r, EINVAL);
    struct pcj_recovery *c = calloc(1, sizeof(*c));
    struct pcj *j = calloc(1, sizeof(*j));
    if (!c || !j) { free(c); free(j); return fail(r, ENOMEM); }
    c->journal = j; c->anchor = *anchor; c->next_generation = next_generation; c->max_tail = max_tail;
    j->identity = id; j->model = model; j->process = getpid(); j->binding = *binding;
    j->fd = opened(fd, ".", O_RDONLY | O_DIRECTORY);
    if (j->fd < 0) { int error = errno; free(j); free(c); return fail(r, error); }
    int error = 0;
    if (directory(j) || flock(j->fd, LOCK_EX | LOCK_NB)) error = errno;
    else if (classify(c, 0, r)) { error = r->error; c->view.kind = PCJ_TAIL_IO_UNKNOWN; }
    if (!error && c->view.kind == PCJ_TAIL_COMPLETE &&
        next_generation <= j->state.head.owner_generation) error = ESTALE;
    if (error) {
        *view = c->view;
        fail(r, error); close_one(j->fd, r); free(j); free(c); errno = r->error; return -1;
    }
    *view = c->view; *out = c; return 0;
}
static int recovery_live(struct pcj_recovery *c, struct pcj_result *r) {
    if (!c || !c->journal || c->journal->process != getpid() || c->journal->poisoned)
        return fail(r, EPERM);
    if (c->view.kind != PCJ_TAIL_COMPLETE || !c->view.prefix_verified) return fail(r, EBADMSG);
    return 0;
}
static int recheck(struct pcj_recovery *c, struct pcj_result *r) {
    struct pcj_recovery_view before = c->view;
    int error = 0;
    if (classify(c, 1, r)) error = r->error;
    else if (c->view.kind != PCJ_TAIL_COMPLETE || c->view.records != before.records ||
        !same_head(&before.observed.head, &c->view.observed.head)) error = ESTALE;
    else if (fsync(c->journal->fd)) error = errno;
    if (error) {
        c->journal->poisoned = 1;
        return fail(r, error);
    }
    return 0;
}
int pcj_recovery_prepare(struct pcj_recovery *c,
                         unsigned char request[PCJ_RECOVERY_REQUEST_BYTES], struct pcj_result *r) {
    if (!r) { errno = EINVAL; return -1; }
    *r = (struct pcj_result){0};
    if (!request) return fail(r, EINVAL);
    memset(request, 0, PCJ_RECOVERY_REQUEST_BYTES);
    if (recovery_live(c, r) || recheck(c, r)) return -1;
    if (!c->prepared) {
        unsigned char *w = c->request;
        memcpy(w, "PCJQ0001", 8); bind_wire(w, &c->journal->binding);
        put64(w + 8, c->anchor.head.sequence); put64(w + 16, c->anchor.head.owner_generation);
        put64(w + 24, c->view.observed.head.sequence); put64(w + 32, c->view.observed.head.owner_generation);
        memcpy(w + 672, c->anchor.head.digest, 32); memcpy(w + 704, c->view.observed.head.digest, 32);
        put64(w + 736, c->anchor.revision); put64(w + 744, c->anchor.fence_generation);
        put64(w + 752, c->next_generation); put64(w + 760, c->max_tail);
        put64(w + 768, (uint64_t)c->journal->identity.device);
        put64(w + 776, (uint64_t)c->journal->identity.inode);
        put64(w + 784, (uint64_t)c->journal->identity.owner);
        if (RAND_bytes(w + 800, 32) != 1) return fail(r, EIO);
        c->prepared = 1;
    }
    memcpy(request, c->request, PCJ_RECOVERY_REQUEST_BYTES);
    return 0;
}
int pcj_recovery_copy_tail(struct pcj_recovery *c, uint64_t sequence,
                           unsigned char wire[PCJ_WIRE_BYTES],
                           struct pcj_result *r) {
    if (!r) { errno = EINVAL; return -1; }
    *r = (struct pcj_result){0};
    if (!wire) return fail(r, EINVAL);
    memset(wire, 0, PCJ_WIRE_BYTES);
    if (recovery_live(c, r)) return -1;
    if (!c->prepared || sequence <= c->anchor.head.sequence || sequence > c->view.records)
        return fail(r, EINVAL);
    if (recheck(c, r)) return -1;
    char name[32]; name_for(name, sequence);
    int fd = opened(c->journal->fd, name, O_RDONLY);
    if (fd < 0) return fail(r, errno);
    int error = read_wire(c->journal, fd, name, wire) ? errno : 0;
    if (error) fail(r, error);
    close_one(fd, r);
    if (r->error) { c->journal->poisoned = 1; memset(wire, 0, PCJ_WIRE_BYTES); return -1; }
    return 0;
}
static int verify_receipt(struct pcj_recovery *c, const unsigned char *receipt) {
#ifdef PCJ_TEST_WITNESS_KEY_HEX
    /* Fixed compile-time TEST key; impossible to select a key through API data. */
    if (!c->journal->model) { errno = EOPNOTSUPP; return -1; }
    const char *hex = PCJ_TEST_WITNESS_KEY_HEX;
    unsigned char key[32];
    if (strlen(hex) != 64) { errno = EINVAL; return -1; }
    for (int i = 0; i < 32; i++) {
        unsigned int value;
        if (sscanf(hex + 2*i, "%2x", &value) != 1) { errno = EINVAL; return -1; }
        key[i] = (unsigned char)value;
    }
    EVP_PKEY *pkey = EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, NULL, key, sizeof(key));
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    int valid = pkey && ctx && EVP_DigestVerifyInit(ctx, NULL, NULL, NULL, pkey) == 1 &&
        EVP_DigestVerify(ctx, receipt + 64, 64, receipt, 64) == 1;
    EVP_MD_CTX_free(ctx); EVP_PKEY_free(pkey);
    if (!valid) { errno = EACCES; return -1; }
    return 0;
#else
    (void)c; (void)receipt;
    errno = EOPNOTSUPP; return -1;
#endif
}
int pcj_recovery_accept(struct pcj_recovery **owned,
                        const unsigned char receipt[PCJ_RECOVERY_RECEIPT_BYTES],
                        struct pcj **out, enum pcj_cas_state *cas, struct pcj_result *r) {
    if (!r) { errno = EINVAL; return -1; }
    *r = (struct pcj_result){0};
    if (out) *out = NULL;
    if (cas) *cas = PCJ_CAS_UNAVAILABLE;
    if (!owned || !*owned || !out || !cas) return fail(r, EINVAL);
    struct pcj_recovery *c = *owned;
    if (recovery_live(c, r)) return -1;
    if (!c->prepared) return fail(r, EINVAL);
    if (!receipt) { *cas = PCJ_CAS_UNKNOWN; return fail(r, EAGAIN); }
    if (verify_receipt(c, receipt)) return fail(r, errno);
    unsigned char sum[32]; unsigned int n;
    if (EVP_Digest(c->request, sizeof(c->request), sum, &n, EVP_sha256(), NULL) != 1 || n != 32)
        return fail(r, EIO);
    if (memcmp(receipt, "PCJRA001", 8) || memcmp(receipt + 8, sum, 32) ||
        get64(receipt + 56) != c->next_generation) return fail(r, ESTALE);
    uint64_t status = get64(receipt + 40), revision = get64(receipt + 48);
    if (status == PCJ_CAS_UNKNOWN) { *cas = PCJ_CAS_UNKNOWN; return fail(r, EAGAIN); }
    if (status == PCJ_CAS_REJECTED) { *cas = PCJ_CAS_REJECTED; return fail(r, ESTALE); }
    if (status != PCJ_CAS_COMMITTED || revision != c->anchor.revision + 1) return fail(r, ESTALE);
    *cas = PCJ_CAS_COMMITTED; /* external commit fact survives a later local failure */
    if (recheck(c, r)) return -1;
    struct pcj *j = c->journal;
    j->owner_acquired = 0; j->validated_generation = 0;
    j->reserved_generation = c->next_generation;
    *out = j; *owned = NULL; free(c);
    return 0;
}
int pcj_recovery_close(struct pcj_recovery **owned, struct pcj_result *r) {
    if (!r) { errno = EINVAL; return -1; }
    *r = (struct pcj_result){0};
    if (!owned || !*owned) return fail(r, EINVAL);
    struct pcj_recovery *c = *owned; *owned = NULL;
    int rc = pcj_close(&c->journal, r); free(c); return rc;
}
