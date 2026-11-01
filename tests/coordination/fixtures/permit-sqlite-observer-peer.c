#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#include "../../../packages/permit-sqlite-observer/observer.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

/* Exclusive test instrumentation. Observer is separately compiled with syscall
 * renames; all successful operations below still use real kernel syscalls.
 * No hooks, worker, fork, test gate or injection API in the library itself. */
static const char *mode, *directory_path, *db_name;
static struct pso_identity expected;
static int opened = -1, open_count, stat_count, read_count, close_count;
static int bytes_read, wrong_reads, once, reused = -1, leaked[4], leak_count;
static int final_precheck_seen, changed_header_read;
static int seen_close[4096];

static int is_mode(const char *s) { return !strcmp(mode, s); }
static void checked(int rc) { if (rc) { perror("exclusive fixture operation"); exit(91); } }

static void mutate(const char *action) {
    if (!strcmp(action, "replace")) checked(renameat(3, "replacement.sqlite", 3, db_name));
    else if (!strcmp(action, "symlink")) {
        checked(unlinkat(3, db_name, 0));
        checked(symlinkat("replacement.sqlite", 3, db_name));
    } else if (!strcmp(action, "ancestor")) {
        char held[4096], other[4096];
        assert(snprintf(held, sizeof(held), "%s-held", directory_path) < (int)sizeof(held));
        assert(snprintf(other, sizeof(other), "%s-other", directory_path) < (int)sizeof(other));
        checked(rename(directory_path, held));
        checked(symlink(other, directory_path));
    } else if (!strcmp(action, "sidecar")) {
        int fd = openat(3, "store.sqlite-wal", O_WRONLY | O_CREAT | O_EXCL, 0600);
        assert(fd >= 0); checked(close(fd));
    } else if (!strcmp(action, "sidecar-replace")) {
        checked(renameat(3, "sidecar-replacement", 3, "store.sqlite-wal"));
    } else if (!strcmp(action, "sidecar-remove")) checked(unlinkat(3, "store.sqlite-wal", 0));
    else if (!strcmp(action, "unlink")) checked(unlinkat(3, db_name, 0));
    else if (!strcmp(action, "link")) checked(linkat(3, db_name, 3, "new-hardlink", 0));
    else {
        int fd = openat(3, db_name, O_WRONLY | O_NOFOLLOW);
        assert(fd >= 0);
        if (!strcmp(action, "grow")) checked(ftruncate(fd, 8192));
        else if (!strcmp(action, "truncate")) checked(ftruncate(fd, 10));
        else if (!strcmp(action, "write-before-read")) {
            const unsigned char version[4] = {0, 0, 0, 99};
            assert(pwrite(fd, version, sizeof(version), 60) == (ssize_t)sizeof(version));
        } else { unsigned char byte = 99; assert(pwrite(fd, &byte, 1, 60) == 1); }
        checked(close(fd));
    }
}

static void process_mutation(const char *action) {
    /* Deterministic two-process interleaving, not synthetic stat/read data. */
    int ready[2]; checked(pipe(ready));
    pid_t child = fork(); assert(child >= 0);
    if (!child) {
        checked(close(ready[0])); mutate(action);
        assert(write(ready[1], "x", 1) == 1); _exit(0);
    }
    checked(close(ready[1])); char token;
    assert(read(ready[0], &token, 1) == 1); checked(close(ready[0]));
    int status; assert(waitpid(child, &status, 0) == child);
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
}

int pso_test_openat(int dir, const char *name, int flags, ...) {
    assert(dir != AT_FDCWD && !strchr(name, '/'));
    assert(!strcmp(name, db_name)); /* sidecars must NEVER be opened */
    assert((flags & O_ACCMODE) == O_RDONLY);
    assert(!(flags & (O_CREAT | O_TRUNC | O_APPEND)));
    assert((flags & (O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)) == (O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK));
    open_count++;
    if (is_mode("replace-at-open")) process_mutation("replace");
    if (is_mode("symlink-at-open")) process_mutation("symlink");
    if (is_mode("open-permission")) { errno = EACCES; return -1; }
    opened = openat(dir, name, flags);
    if (opened >= 0) {
        assert(fcntl(opened, F_GETFD) & FD_CLOEXEC);
        if (is_mode("replace-after-open")) process_mutation("replace");
    }
    return opened;
}

int pso_test_fstatat(int dir, const char *name, struct stat *st, int flags) {
    assert(dir != AT_FDCWD && flags == AT_SYMLINK_NOFOLLOW);
    assert(!strcmp(name, db_name) || !strcmp(name, "store.sqlite-wal") ||
        !strcmp(name, "store.sqlite-shm") || !strcmp(name, "store.sqlite-journal"));
    stat_count++;
    if (is_mode("ancestor-before-sidecar") && !once++) process_mutation("ancestor");
    if (is_mode("stat-permission")) { errno = EPERM; return -1; }
    if (is_mode("stat-io")) { errno = EIO; return -1; }
    if (is_mode("missing-appears") && !strcmp(name, db_name) && once++) process_mutation("replace");
    return fstatat(dir, name, st, flags);
}
int pso_test_fstat(int fd, struct stat *st) {
    if (is_mode("fstat-io") && fd == opened) { errno = EIO; return -1; }
    int rc = fstat(fd, st);
    if (!rc && opened >= 0 && fd != opened && !read_count && S_ISDIR(st->st_mode)) final_precheck_seen = 1;
    return rc;
}
ssize_t pso_test_pread(int fd, void *buffer, size_t size, off_t offset) {
    struct stat st; checked(fstat(fd, &st));
    if (st.st_dev != expected.device || st.st_ino != expected.inode || st.st_uid != expected.owner) wrong_reads++;
    assert(!wrong_reads && offset >= 0 && offset + (off_t)size <= 100);
    read_count++;
    if (is_mode("read-permission") || is_mode("primary-and-close")) { errno = EACCES; return -1; }
    if (is_mode("read-eintr")) { errno = EINTR; return -1; }
    if (is_mode("read-eof")) return 0;
    if (is_mode("short-read") && size > 1) size = 1;
    unsigned char changed_header[100];
    if (is_mode("write-before-read")) {
        /* Observer has completed its final directory fstat and is about to
         * issue its FIRST real pread. Only the fixture reads this baseline;
         * no stat/header result returned to the observer is synthesized. */
        assert(final_precheck_seen && read_count == 1 && offset == 0 && size == 100);
        assert(pread(fd, changed_header, sizeof(changed_header), 0) == (ssize_t)sizeof(changed_header));
        assert(changed_header[60] == 0 && changed_header[61] == 0 &&
               changed_header[62] == 0 && changed_header[63] == 2);
        process_mutation("write-before-read");
        struct stat after; checked(fstat(fd, &after));
        assert(after.st_dev == st.st_dev && after.st_ino == st.st_ino &&
               after.st_uid == st.st_uid && after.st_size == st.st_size);
        changed_header[63] = 99;
    }
    ssize_t n = pread(fd, buffer, size, offset);
    if (is_mode("write-before-read")) {
        assert(n == 100 && !memcmp(buffer, changed_header, sizeof(changed_header)));
        changed_header_read = 1;
    }
    if (n > 0) bytes_read += (int)n;
    if (!once++) {
        const char *action = NULL;
        if (is_mode("replace-after-read")) action = "replace";
        if (is_mode("ancestor-after-read")) action = "ancestor";
        if (is_mode("write-after-read")) action = "write";
        if (is_mode("grow-after-read")) action = "grow";
        if (is_mode("truncate-after-read")) action = "truncate";
        if (is_mode("unlink-after-read")) action = "unlink";
        if (is_mode("link-after-read")) action = "link";
        if (is_mode("sidecar-after-read")) action = "sidecar";
        if (is_mode("sidecar-replace")) action = "sidecar-replace";
        if (is_mode("sidecar-remove")) action = "sidecar-remove";
        if (action) process_mutation(action);
    }
    return n;
}
int pso_test_close(int fd) {
    assert(fd >= 0 && fd < 4096 && !seen_close[fd]++);
    close_count++;
    if (is_mode("close-before") || is_mode("primary-and-close")) {
        leaked[leak_count++] = fd; errno = EINTR; return -1;
    }
    checked(close(fd));
    if (is_mode("close-after")) { errno = EINTR; return -1; }
    if (is_mode("close-reuse") && fd == opened) {
        reused = openat(3, db_name, O_RDONLY | O_CLOEXEC);
        assert(reused == fd); errno = EINTR; return -1;
    }
    return 0;
}

static struct pso_identity parse_identity(char **args) {
    return (struct pso_identity){ (dev_t)strtoull(args[0], NULL, 10),
        (ino_t)strtoull(args[1], NULL, 10), (uid_t)strtoull(args[2], NULL, 10) };
}
int main(int argc, char **argv) {
    assert(argc == 10);
    directory_path = argv[1]; db_name = argv[2]; mode = argv[3];
    struct pso_identity directory = parse_identity(argv + 4);
    expected = parse_identity(argv + 7);
    struct stat original; checked(fstat(3, &original));
    int base = 3;
    if (is_mode("at-fdcwd")) base = AT_FDCWD;
    if (is_mode("closed-fd")) { base = dup(3); assert(base >= 0); checked(close(base)); }
    pid_t racer = -1;
    int ready[2] = {-1, -1};
    if (is_mode("race")) {
        checked(pipe(ready)); racer = fork(); assert(racer >= 0);
        if (!racer) {
            checked(close(ready[0])); assert(write(ready[1], "x", 1) == 1);
            for (;;) {
                checked(renameat(3, db_name, 3, "parked"));
                checked(renameat(3, "replacement.sqlite", 3, db_name));
                checked(renameat(3, db_name, 3, "replacement.sqlite"));
                checked(renameat(3, "parked", 3, db_name));
            }
        }
        checked(close(ready[1])); char byte; assert(read(ready[0], &byte, 1) == 1); checked(close(ready[0]));
    }
    struct pso_result result;
    int rc = -1, unknown = 0, iterations = racer > 0 ? 300 : 1;
    for (int i = 0; i < iterations; i++) {
        memset(seen_close, 0, sizeof(seen_close)); opened = -1;
        rc = pso_observe_at(base, is_mode("null-name") ? NULL : db_name, directory, expected, &result);
        if (rc) unknown++;
        assert(result.blocked && !result.execution_authorized && result.snapshot_unproven && result.path_binding_unproven);
        if (rc) assert(!result.header_valid && !result.page_size && !result.user_version);
    }
    if (racer > 0) { checked(kill(racer, SIGKILL)); int status; assert(waitpid(racer, &status, 0) == racer); }
    if (reused >= 0) { struct stat st; checked(fstat(reused, &st)); checked(close(reused)); }
    for (int i = 0; i < leak_count; i++) checked(close(leaked[i]));
    struct stat final; checked(fstat(3, &final));
    assert(original.st_dev == final.st_dev && original.st_ino == final.st_ino);
    printf("{\"rc\":%d,\"state\":%d,\"format\":%d,\"headerValid\":%d,\"version\":%d,\"pageSize\":%u,"
           "\"sidecars\":[%d,%d,%d],\"cleanupUnknown\":%d,\"opens\":%d,\"stats\":%d,\"reads\":%d,"
           "\"bytesRead\":%d,\"wrongReads\":%d,\"changedHeaderRead\":%d,\"closes\":%d,\"iterations\":%d,\"unknown\":%d,"
           "\"blocked\":true,\"executionAuthorized\":false,\"snapshotUnproven\":true,\"pathBindingUnproven\":true}\n",
           rc, result.state, result.format, result.header_valid, result.user_version, result.page_size,
           result.sidecars[0], result.sidecars[1], result.sidecars[2], result.cleanup_unknown,
           open_count, stat_count, read_count, bytes_read, wrong_reads, changed_header_read, close_count, iterations, unknown);
    return 0;
}
