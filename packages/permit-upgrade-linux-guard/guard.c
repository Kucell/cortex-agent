#define _GNU_SOURCE
#include "guard.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/magic.h>
#include <linux/openat2.h>
#include <stdint.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <unistd.h>

struct pg_guard {
    int parent_fd, lock_fd;
    pid_t process;
    struct pg_identity parent, directory;
    const char *relative;
    struct pg_result *result;
};

static void error_first(struct pg_result *result, int error) {
    if (!result->error) result->error = error;
}

/* Invalidate ownership before the single close call. Neither EINTR nor any
 * other error permits a retry, fcntl probe, or close of the old number. */
static void close_once(int *owned, struct pg_result *result, int *close_error) {
    if (*owned < 0) return;
    int fd = *owned;
    *owned = -1;
    if (close(fd)) {
        int saved = errno;
        if (!*close_error) *close_error = saved;
        error_first(result, saved);
    }
}

static int open_directory(int base, const char *name) {
    struct open_how how = {
        .flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
                   RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV
    };
    return (int)syscall(SYS_openat2, base, name, &how, sizeof(how));
}

static int identity(int fd, struct pg_identity expected) {
    struct stat st;
    struct statfs fs;
    if (fstat(fd, &st) || fstatfs(fd, &fs)) return -1;
    if (!S_ISDIR(st.st_mode) || st.st_dev != expected.device ||
        st.st_ino != expected.inode || st.st_uid != expected.owner ||
        (st.st_mode & (S_IWGRP | S_IWOTH))) { errno = ESTALE; return -1; }
    /* Conservative local-kernel allowlist. In particular: no NFS, CIFS, FUSE,
     * virtiofs or overlayfs. tmpfs is useful for actual kernel-lock tests, not
     * a durable production control domain. No kernel-version inference. */
    if (fs.f_type != EXT4_SUPER_MAGIC && fs.f_type != XFS_SUPER_MAGIC &&
        fs.f_type != BTRFS_SUPER_MAGIC && fs.f_type != TMPFS_MAGIC) {
        errno = EOPNOTSUPP; return -1;
    }
    return 0;
}

int pg_check(const struct pg_guard *g) {
    if (!g || g->process != getpid()) { errno = EPERM; return -1; }
    if (g->result->error) { errno = g->result->error; return -1; }
    if (identity(g->parent_fd, g->parent) || identity(g->lock_fd, g->directory)) {
        error_first(g->result, errno); return -1;
    }
    int current = open_directory(g->parent_fd, g->relative);
    if (current < 0) { error_first(g->result, errno); return -1; }
    if (identity(current, g->directory)) error_first(g->result, errno);
    close_once(&current, g->result, &g->result->check_close_error);
    if (g->result->error) { errno = g->result->error; return -1; }
    return 0;
}

static int relative_name(const char *name) {
    if (!name || !*name || strlen(name) > 1024 || name[0] == '/') return 0;
    if (!strcmp(name, ".")) return 1;
    const char *p = name;
    while (*p) {
        const char *end = strchr(p, '/');
        size_t n = end ? (size_t)(end - p) : strlen(p);
        if (!n || (n == 1 && p[0] == '.') ||
            (n == 2 && p[0] == '.' && p[1] == '.')) return 0;
        if (!end) return 1;
        p = end + 1;
        if (!*p) return 0;
    }
    return 0;
}

int pg_controller_run(int parent_fd, const char *relative,
                      struct pg_identity parent, struct pg_identity directory,
                      int exclusive, pg_controller_work work, void *context,
                      struct pg_result *result) {
    if (!result) { errno = EINVAL; return -1; }
    *result = (struct pg_result){0};
    if (!relative_name(relative) || !work || (exclusive != 0 && exclusive != 1)) {
        result->error = errno = EINVAL; return -1;
    }
    /* Copy caller memory before work: it cannot retarget the check later. */
    char name[1025];
    strcpy(name, relative);
    struct pg_guard g = { .parent_fd = -1, .lock_fd = -1, .process = getpid(),
                         .parent = parent, .directory = directory, .relative = name, .result = result };
    g.parent_fd = open_directory(parent_fd, ".");
    if (g.parent_fd < 0) { result->error = errno; return -1; }
    if (identity(g.parent_fd, parent)) goto failed;
    g.lock_fd = open_directory(g.parent_fd, name);
    if (g.lock_fd < 0 || identity(g.lock_fd, directory)) goto failed;
    int rc;
    do { rc = flock(g.lock_fd, exclusive ? LOCK_EX : LOCK_SH); } while (rc && errno == EINTR);
    if (rc) goto failed;
    result->lock_state = PG_HELD;
    if (pg_check(&g)) goto failed;
    result->work_started = 1;
    errno = 0;
    rc = work(&g, context);
    if (rc) error_first(result, errno ? errno : ECANCELED);
    else result->work_completed = 1;
    if (rc != 0 || pg_check(&g) != 0) {
        /* No proof of safe completion: keep the same OFD alive. Signals retain
         * normal process-death semantics; never claim to fence other workers. */
        for (;;) pause();
    }
    goto cleanup;
failed:;
    error_first(result, errno);
cleanup:;
    int acquired = result->lock_state == PG_HELD;
    close_once(&g.lock_fd, result, &result->lock_close_error);
    if (acquired) result->lock_state = result->lock_close_error ? PG_RELEASE_UNKNOWN : PG_RELEASED;
    close_once(&g.parent_fd, result, &result->parent_close_error);
    if (result->error) { errno = result->error; return -1; }
    return 0;
}
