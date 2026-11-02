/* Native diagnostic controller for real-process tests. NOT a production CLI.
 * Only fixed test markers are writable; no user code, SQLite, stamp, registration,
 * discovery result import, installer, worker or production authorization API. */
#define _GNU_SOURCE
#include "guard.h"
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/openat2.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

struct session { int input_root, output; unsigned lifetime; char token[65], upgrade[65]; };
static const char *phases[] = { "configuration", "final-verification", "stamp-marker", "report-marker" };
static int64_t milliseconds(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) _exit(71);
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static int emit(const char *text) {
    size_t n = strlen(text);
    while (n) {
        ssize_t done = write(STDOUT_FILENO, text, n);
        if (done < 0 && errno == EINTR) continue;
        if (done <= 0) return -1;
        text += done; n -= (size_t)done;
    }
    return 0;
}
static int marker(int dir, const char *name, const char *body) {
    int fd = openat(dir, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0) return -1;
    size_t n = strlen(body), offset = 0;
    int rc = 0;
    while (offset < n) {
        ssize_t written = write(fd, body + offset, n - offset);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) { rc = -1; break; }
        offset += (size_t)written;
    }
    if (!rc && fsync(fd)) rc = -1;
    if (close(fd)) rc = -1;
    if (!rc && fsync(dir)) rc = -1;
    return rc;
}
static int incomplete(struct session *s, const char *reason) {
    char body[256], line[512];
    snprintf(body, sizeof(body), "v1 upgrade=%s state=upgrade-incomplete reason=%s\n", s->upgrade, reason);
    int recorded = marker(s->output, "upgrade-incomplete", body) == 0;
    snprintf(line, sizeof(line), "{\"event\":\"incomplete\",\"reason\":\"%s\",\"recorded\":%s,\"discovery\":\"discovery-unknown\",\"executionAuthorized\":false}\n", reason, recorded ? "true" : "false");
    (void)emit(line);
    return -1; /* pg_controller_run fail-stops without unlocking. */
}
static int read_line(char *line, size_t size, int64_t deadline) {
    size_t used = 0;
    for (;;) {
        int64_t remaining = deadline - milliseconds();
        if (remaining <= 0) return -2;
        struct pollfd p = { .fd = STDIN_FILENO, .events = POLLIN };
        int rc = poll(&p, 1, (int)remaining);
        if (rc < 0 && errno == EINTR) continue;
        if (rc <= 0) return -2;
        char c;
        ssize_t n = read(STDIN_FILENO, &c, 1);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        if (c == '\n') { line[used] = 0; return 0; }
        if (c < 32 || c > 126 || used + 1 >= size) return -3;
        line[used++] = c;
    }
}
static int work(const struct pg_guard *g, void *context) {
    struct session *s = context;
    /* Prove caller's descriptor lifetime/number is unrelated to private OFD. */
    close(s->input_root);
    int reused = open("/dev/null", O_RDONLY | O_CLOEXEC);
    char out[512];
    snprintf(out, sizeof(out), "{\"event\":\"held\",\"incarnation\":\"%s\",\"upgradeId\":\"%s\",\"pid\":%ld,\"fdReused\":%s,\"discovery\":\"discovery-unknown\",\"executionAuthorized\":false}\n", s->token, s->upgrade, (long)getpid(), reused == s->input_root ? "true" : "false");
    if (reused >= 0) close(reused);
    if (emit(out)) return incomplete(s, "output-disconnected");
    int64_t deadline = milliseconds() + s->lifetime;
    unsigned sequence = 1, phase = 0;
    for (;;) {
        char line[256], expected[256];
        int rc = read_line(line, sizeof(line), deadline);
        if (rc) return incomplete(s, rc == -2 ? "expired" : rc == -1 ? "connection-lost" : "invalid-frame");
        if (pg_check(g)) return incomplete(s, "binding-lost");
        snprintf(expected, sizeof(expected), "CHECK %s %u", s->token, sequence);
        if (!strcmp(line, expected)) {
            sequence++;
            if (emit("{\"event\":\"checked\",\"discovery\":\"discovery-unknown\",\"executionAuthorized\":false}\n")) return incomplete(s, "output-disconnected");
            continue;
        }
        snprintf(expected, sizeof(expected), "STEP %s %u", s->token, sequence);
        if (!strcmp(line, expected) && phase < 4) {
            if (marker(s->output, phases[phase], "diagnostic marker only\n")) return incomplete(s, "marker-failed");
            snprintf(out, sizeof(out), "{\"event\":\"phase\",\"phase\":\"%s\",\"executionAuthorized\":false}\n", phases[phase++]);
            sequence++;
            if (emit(out)) return incomplete(s, "output-disconnected");
            continue;
        }
        snprintf(expected, sizeof(expected), "FINISH %s %u", s->token, sequence);
        if (!strcmp(line, expected) && phase == 4) {
            /* Publication is a separate fact from later check/close success.
             * This output is under lock, but does not promise successful release. */
            if (pg_check(g) || emit("{\"event\":\"diagnostic-work-published\",\"release\":\"pending\",\"executionAuthorized\":false}\n")) return incomplete(s, "finalization-failed");
            return 0;
        }
        return incomplete(s, "protocol-rejected");
    }
}
static int open_absolute(const char *name) {
    if (!name || name[0] != '/') { errno = EINVAL; return -1; }
    struct open_how how = { .flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
        .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
    return (int)syscall(SYS_openat2, AT_FDCWD, name, &how, sizeof(how));
}
static int parse_id(const char *text, uintmax_t *value) {
    if (!*text || strspn(text, "0123456789") != strlen(text)) return -1;
    char *end;
    errno = 0; *value = strtoumax(text, &end, 10);
    return errno || *end ? -1 : 0;
}
int main(int argc, char **argv) {
    /* parent relative parentDev parentIno targetDev targetIno owner mode output upgrade lifetimeMs */
    if (argc != 12) return 64;
    uintmax_t n[5], lifetime;
    for (int i = 0; i < 5; i++) if (parse_id(argv[3 + i], &n[i])) return 64;
    if ((uintmax_t)(dev_t)n[0] != n[0] || (uintmax_t)(ino_t)n[1] != n[1] ||
        (uintmax_t)(dev_t)n[2] != n[2] || (uintmax_t)(ino_t)n[3] != n[3] ||
        (uintmax_t)(uid_t)n[4] != n[4]) return 64;
    if (parse_id(argv[11], &lifetime) || lifetime < 1 || lifetime > 30000 ||
        (strcmp(argv[8], "shared") && strcmp(argv[8], "exclusive")) ||
        !*argv[10] || strlen(argv[10]) > 64 ||
        strspn(argv[10], "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") != strlen(argv[10])) return 64;
    struct session s = { .input_root = open_absolute(argv[1]), .output = open_absolute(argv[9]), .lifetime = (unsigned)lifetime };
    if (s.input_root < 0 || s.output < 0) return 65;
    strcpy(s.upgrade, argv[10]);
    unsigned char random[32];
    if (getrandom(random, sizeof(random), 0) != sizeof(random)) return 71;
    for (unsigned i = 0; i < sizeof(random); i++) snprintf(s.token + i * 2, 3, "%02x", random[i]);
    signal(SIGPIPE, SIG_IGN);
    if (emit("{\"event\":\"waiting\",\"executionAuthorized\":false}\n")) return 74;
    struct pg_identity parent = { (dev_t)n[0], (ino_t)n[1], (uid_t)n[4] };
    struct pg_identity target = { (dev_t)n[2], (ino_t)n[3], (uid_t)n[4] };
    struct pg_result result;
    int rc = pg_controller_run(s.input_root, argv[2], parent, target,
                               !strcmp(argv[8], "exclusive"), work, &s, &result);
    if (rc) {
        char line[512];
        snprintf(line, sizeof(line), "{\"event\":\"refused\",\"errno\":%d,\"workStarted\":%d,\"workCompleted\":%d,\"lockState\":%d,\"checkCloseError\":%d,\"lockCloseError\":%d,\"parentCloseError\":%d,\"discovery\":\"discovery-unknown\",\"executionAuthorized\":false}\n", result.error, result.work_started, result.work_completed, result.lock_state, result.check_close_error, result.lock_close_error, result.parent_close_error);
        (void)emit(line);
    }
    close(s.output);
    return rc ? 70 : 0;
}
