#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#include "observer.h"
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#if !defined(__APPLE__) && !defined(__linux__)
#error "permit-sqlite-observer requires reviewed POSIX stat timestamp semantics"
#endif

static enum pso_state io_state(void) {
    return errno == EACCES || errno == EPERM ? PSO_PERMISSION_UNKNOWN : PSO_IO_UNKNOWN;
}

static int identity(const struct stat *st, struct pso_identity expected) {
    return st->st_ino != 0 && st->st_dev == expected.device &&
        st->st_ino == expected.inode && st->st_uid == expected.owner;
}

static int same(const struct stat *a, const struct stat *b) {
#if defined(__APPLE__)
    const struct timespec am = a->st_mtimespec, bm = b->st_mtimespec;
    const struct timespec ac = a->st_ctimespec, bc = b->st_ctimespec;
#else
    const struct timespec am = a->st_mtim, bm = b->st_mtim;
    const struct timespec ac = a->st_ctim, bc = b->st_ctim;
#endif
    /* atime deliberately excluded: our own read may change it. */
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
        a->st_mode == b->st_mode && a->st_nlink == b->st_nlink &&
        a->st_uid == b->st_uid && a->st_gid == b->st_gid &&
        a->st_size == b->st_size && am.tv_sec == bm.tv_sec &&
        am.tv_nsec == bm.tv_nsec && ac.tv_sec == bc.tv_sec && ac.tv_nsec == bc.tv_nsec;
}

struct observation { int present; struct stat st; };
static int optional(int dir, const char *name, struct observation *o) {
    *o = (struct observation){0};
    if (!fstatat(dir, name, &o->st, AT_SYMLINK_NOFOLLOW)) { o->present = 1; return 0; }
    return errno == ENOENT ? 0 : -1;
}
static int unchanged(const struct observation *a, const struct observation *b) {
    return a->present == b->present && (!a->present || same(&a->st, &b->st));
}
static enum pso_type file_type(const struct observation *o) {
    if (!o->present) return PSO_ABSENT;
    mode_t m = o->st.st_mode;
    if (S_ISREG(m)) return PSO_REGULAR;
    if (S_ISDIR(m)) return PSO_DIRECTORY;
    if (S_ISLNK(m)) return PSO_SYMLINK;
    if (S_ISFIFO(m)) return PSO_FIFO;
    if (S_ISSOCK(m)) return PSO_SOCKET;
    if (S_ISBLK(m)) return PSO_BLOCK;
    if (S_ISCHR(m)) return PSO_CHARACTER;
    return PSO_OTHER;
}
static uint32_t be32(const unsigned char *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static void header(const unsigned char *b, size_t used, off_t size, struct pso_result *r) {
    r->format = PSO_CORRUPT_HEADER;
    if (used != 100 || memcmp(b, "SQLite format 3\0", 16)) return;
    uint32_t page = ((uint32_t)b[16] << 8) | b[17];
    if (page == 1) page = 65536;
    if (page < 512 || page > 65536 || (page & (page - 1)) ||
        (b[18] != 1 && b[18] != 2) || (b[19] != 1 && b[19] != 2) ||
        page - b[20] < 480 || b[21] != 64 || b[22] != 32 || b[23] != 32 ||
        be32(b + 44) > 4 || be32(b + 56) > 3 || size < (off_t)page || size % page) return;
    for (size_t i = 72; i < 92; i++) if (b[i]) return;
    uint32_t raw = be32(b + 60);
    /* Avoid implementation-defined unsigned->signed overflow. SQLite exposes
     * PRAGMA user_version as signed int32, including negative versions. */
    r->user_version = (int32_t)(raw <= INT32_MAX ? (int64_t)raw : (int64_t)raw - INT64_C(4294967296));
    r->page_size = page;
    r->header_valid = 1;
    switch (r->user_version) {
        case 1: r->format = PSO_SCHEMA1_NEEDS_MIGRATION; break;
        case 2: r->format = PSO_SCHEMA2_HEADER_ONLY; break;
        case 3: r->format = PSO_SCHEMA3_DEVELOPMENT_AUTHORITY_UNSUPPORTED; break;
        default: r->format = PSO_UNKNOWN_SCHEMA; break;
    }
}

int pso_observe_at(int directory_fd, const char *basename,
                   struct pso_identity directory, struct pso_identity target,
                   struct pso_result *r) {
    if (!r) return -1;
    *r = (struct pso_result){ .state = PSO_INVALID_INPUT, .blocked = 1,
        .snapshot_unproven = 1, .path_binding_unproven = 1 };
    if (directory_fd < 0 || !basename || !directory.inode || !target.inode) return -1;
    size_t n = strnlen(basename, 248);
    if (!n || n > 247 || !strcmp(basename, ".") || !strcmp(basename, "..")) return -1;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)basename[i];
        if (c < 32 || c == 127 || c == '/' || c == '\\') return -1;
    }
    char names[3][256], name[248];
    const char *suffixes[3] = { "-wal", "-shm", "-journal" };
    memcpy(name, basename, n + 1);
    for (int i = 0; i < 3; i++) {
        memcpy(names[i], name, n);
        strcpy(names[i] + n, suffixes[i]);
    }
    int dir = -1, db = -1;
    struct stat parent, current;
    struct observation before, after, sidecars[3];
    unsigned char bytes[100] = {0};
    size_t used = 0;
    r->state = PSO_IO_UNKNOWN;
    /* Duplicate the actual description, never reopen by path or /dev/fd. */
    dir = fcntl(directory_fd, F_DUPFD_CLOEXEC, 0);
    if (dir < 0) { r->state = io_state(); goto done; }
    if (fstat(dir, &parent)) { r->state = io_state(); goto done; }
    if (!identity(&parent, directory)) { r->state = PSO_IDENTITY_UNKNOWN; goto done; }
    if (!S_ISDIR(parent.st_mode) || !parent.st_nlink ||
        (parent.st_mode & (S_IWGRP | S_IWOTH))) { r->state = PSO_UNSAFE_UNKNOWN; goto done; }
    for (int i = 0; i < 3; i++) {
        if (optional(dir, names[i], &sidecars[i])) { r->state = io_state(); goto done; }
    }
    if (optional(dir, name, &before)) { r->state = io_state(); goto done; }
    if (before.present) {
        if (!identity(&before.st, target)) { r->state = PSO_IDENTITY_UNKNOWN; goto done; }
        if (!S_ISREG(before.st.st_mode) || before.st.st_nlink != 1 ||
            before.st.st_size < 0 || before.st.st_dev != parent.st_dev) {
            r->state = PSO_UNSAFE_UNKNOWN; goto done;
        }
        db = openat(dir, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
        if (db < 0) { r->state = io_state(); goto done; }
        if (fstat(db, &current)) { r->state = io_state(); goto done; }
        if (!identity(&current, target) || !same(&before.st, &current)) goto changed;
        if (optional(dir, name, &after)) { r->state = io_state(); goto done; }
        if (!unchanged(&before, &after)) goto changed;
        if (fstat(dir, &current)) { r->state = io_state(); goto done; }
        if (!same(&parent, &current)) goto changed;
        size_t limit = before.st.st_size < 100 ? (size_t)before.st.st_size : 100;
        while (used < limit) {
            ssize_t count = pread(db, bytes + used, limit - used, (off_t)used);
            if (count < 0) { r->state = io_state(); goto done; }
            if (!count || (size_t)count > limit - used) goto changed;
            used += (size_t)count;
        }
    }
    if (db >= 0) {
        if (fstat(db, &current)) { r->state = io_state(); goto done; }
        if (!same(&before.st, &current)) goto changed;
    }
    for (int i = 0; i < 3; i++) {
        if (optional(dir, names[i], &after)) { r->state = io_state(); goto done; }
        if (!unchanged(&sidecars[i], &after)) goto changed;
    }
    if (optional(dir, name, &after)) { r->state = io_state(); goto done; }
    if (!unchanged(&before, &after)) goto changed;
    if (fstat(dir, &current)) { r->state = io_state(); goto done; }
    if (!same(&parent, &current)) goto changed;
    r->state = before.present ? PSO_OBSERVED : PSO_MISSING;
    if (before.present) header(bytes, used, before.st.st_size, r);
    else r->format = PSO_FORMAT_MISSING;
    for (int i = 0; i < 3; i++) r->sidecars[i] = file_type(&sidecars[i]);
    goto done;
changed:
    r->state = PSO_CHANGED_UNKNOWN;
done:
    /* No close retry or probe of a possibly reused descriptor number. */
    if (db >= 0 && close(db)) r->cleanup_unknown = 1;
    if (dir >= 0 && close(dir)) r->cleanup_unknown = 1;
    if (r->cleanup_unknown && (r->state == PSO_OBSERVED || r->state == PSO_MISSING)) r->state = PSO_CLOSE_UNKNOWN;
    if (r->state != PSO_OBSERVED && r->state != PSO_MISSING) {
        r->header_valid = 0; r->user_version = 0; r->page_size = 0;
        r->format = PSO_FORMAT_UNPROVEN;
        for (int i = 0; i < 3; i++) r->sidecars[i] = PSO_TYPE_UNKNOWN;
        return -1;
    }
    return 0;
}
