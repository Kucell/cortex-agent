/* TEST ONLY: compile guard.c separately with close/fstat symbol replacement.
 * No production injection hook. Actual closes, FD reuse and flock remain real. */
#define _GNU_SOURCE
#include "guard.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static struct pg_result result;
static int calls, fail_at, after_close, identity_fault, stats, reused = -1, retried;
static int fail_cleanup;

int pg_test_fstat(int fd, struct stat *st);
int pg_test_close(int fd);
int pg_test_fstat(int fd, struct stat *st) {
    stats++;
    if (identity_fault && stats == 5) { errno = ESTALE; return -1; }
    return fstat(fd, st);
}
int pg_test_close(int fd) {
    calls++;
    if (fd == reused) retried++;
    if (calls != fail_at && !(fail_cleanup && calls == fail_at + 1)) return close(fd);
    if (after_close) {
        if (close(fd)) _exit(90);
        int replacement = open("/dev/null", O_RDONLY | O_CLOEXEC);
        if (replacement != fd || reused != -1) _exit(91);
        reused = replacement;
    }
    printf("{\"event\":\"close-injected\",\"call\":%d,\"fd\":%d,\"reused\":%d}\n", calls, fd, reused);
    fflush(stdout);
    errno = EINTR; /* Even EINTR must never cause retry. */
    return -1;
}
static int work(const struct pg_guard *guard, void *context) {
    int output = *(int *)context;
    if (write(output, "published\n", 10) != 10 || fsync(output)) return -1;
    if (puts("{\"event\":\"published\",\"executionAuthorized\":false}") < 0 || fflush(stdout)) return -1;
    if (pg_check(guard)) {
        printf("{\"event\":\"check-failed\",\"error\":%d,\"checkCloseError\":%d,\"workStarted\":%d,\"workCompleted\":%d,\"lockState\":%d}\n",
            result.error, result.check_close_error, result.work_started, result.work_completed, result.lock_state);
        fflush(stdout);
        return -1; /* Actual core fail-stop retains flock. */
    }
    return 0;
}
int main(int argc, char **argv) {
    /* root index output failCloseCall before|after identityFault cleanupFault */
    if (argc != 8) return 64;
    fail_at = atoi(argv[4]); after_close = !strcmp(argv[5], "after");
    identity_fault = atoi(argv[6]); fail_cleanup = atoi(argv[7]);
    int parent = open(argv[1], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    int target = open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    int output = open(argv[3], O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    struct stat p, d;
    if (parent < 0 || target < 0 || output < 0 || fstat(parent, &p) || fstat(target, &d)) return 65;
    close(target);
    struct pg_identity parent_id = { p.st_dev, p.st_ino, p.st_uid };
    struct pg_identity target_id = { d.st_dev, d.st_ino, d.st_uid };
    int rc = pg_controller_run(parent, "index", parent_id, target_id, 0, work, &output, &result);
    int saved = errno;
    int reuse_alive = reused >= 0 && fcntl(reused, F_GETFD) >= 0;
    printf("{\"event\":\"result\",\"rc\":%d,\"errno\":%d,\"error\":%d,\"checkCloseError\":%d,\"lockCloseError\":%d,\"parentCloseError\":%d,\"workStarted\":%d,\"workCompleted\":%d,\"lockState\":%d,\"closeCalls\":%d,\"retried\":%d,\"reuseAlive\":%d,\"executionAuthorized\":false}\n",
        rc, saved, result.error, result.check_close_error, result.lock_close_error,
        result.parent_close_error, result.work_started, result.work_completed,
        result.lock_state, calls, retried, reuse_alive);
    fflush(stdout);
    /* Retain process to let JS inspect actual kernel state, including a close
     * rejected BEFORE closure. No cleanup retry; exit alone reaps leaked FDs. */
    char c;
    ssize_t received;
    do { received = read(STDIN_FILENO, &c, 1); } while (received < 0 && errno == EINTR);
    if (received < 0) return 74;
    return rc ? 70 : 0;
}
