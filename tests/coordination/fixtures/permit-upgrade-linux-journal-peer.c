#define _GNU_SOURCE
#include "control-journal.h"
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Test object symbol substitution only; no hooks in production journal. */
static const char *fault;
static int sync_calls, write_calls, close_calls, reused = -1;
ssize_t pcj_test_pwrite(int fd, const void *p, size_t n, off_t at) {
    write_calls++;
    if (fault && !strcmp(fault, "create-kill")) {
        puts("{\"event\":\"boundary\",\"point\":\"create\"}"); for (;;) pause();
    }
    if (fault && !strcmp(fault, "write-eintr") && write_calls == 1) { errno = EINTR; return -1; }
    if (fault && !strcmp(fault, "write-zero")) return 0;
    if (fault && !strcmp(fault, "write-short") && n > 7) n = 7;
    if (fault && !strcmp(fault, "partial-eio")) {
        if (write_calls == 1) return pwrite(fd, p, 17, at);
        errno = EIO; return -1;
    }
    ssize_t rc = pwrite(fd, p, n, at);
    if (fault && !strcmp(fault, "write-kill")) {
        puts("{\"event\":\"boundary\",\"point\":\"write\"}"); for (;;) pause();
    }
    return rc;
}
ssize_t pcj_test_pread(int fd, void *p, size_t n, off_t at) {
    ssize_t rc = pread(fd, p, n, at);
    if (fault && !strcmp(fault, "read-corrupt") && rc > 0) ((unsigned char *)p)[0] ^= 1;
    return rc;
}
int pcj_test_fsync(int fd) {
    sync_calls++;
    int selected = fault && ((!strncmp(fault, "file-", 5) && sync_calls == 1) ||
                            (!strncmp(fault, "dir-", 4) && sync_calls == 2));
    if (selected && strstr(fault, "before")) { errno = EIO; return -1; }
    int rc = fsync(fd);
    if (selected && strstr(fault, "kill")) {
        printf("{\"event\":\"boundary\",\"point\":\"%s\"}\n", fault); for (;;) pause();
    }
    if (selected && strstr(fault, "after")) { errno = EIO; return -1; }
    return rc;
}
int pcj_test_close(int fd) {
    close_calls++;
    /* Opening scans and closes a directory first. Inject after READY resets. */
    if (fault && !strncmp(fault, "close-", 6) && close_calls == 1) {
        if (!strcmp(fault, "close-after")) {
            if (close(fd)) return -1;
            reused = open("/dev/null", O_RDONLY | O_CLOEXEC);
            if (reused != fd) _exit(90);
        }
        errno = EINTR; return -1;
    }
    return close(fd);
}
struct context {
    int journal_fd, model;
    struct pg_identity journal_id;
    struct pcj_binding binding;
    struct pcj_head checkpoint;
    const char *requested_fault;
};
static void state_event(const char *event, struct pcj *j) {
    struct pcj_state s;
    if (pcj_snapshot(j, &s)) { printf("{\"event\":\"poisoned\"}\n"); return; }
    printf("{\"event\":\"%s\",\"sequence\":%llu,\"generation\":%llu,\"attempt\":%llu,"
           "\"stamp\":%d,\"incomplete\":%d,\"eligible\":%d,\"complete\":%d,\"deliveryUnknown\":%d,\"digest\":\"",
           event, (unsigned long long)s.head.sequence, (unsigned long long)s.head.owner_generation,
           (unsigned long long)s.attempt, s.stamp, s.incomplete, s.eligible, s.complete, s.delivery_unknown);
    for (int i = 0; i < 32; i++) printf("%02x", s.head.digest[i]);
    puts("\",\"executionAuthorized\":false}");
}
static int work(const struct pg_guard *guard, void *opaque) {
    struct context *c = opaque;
    struct pcj *j = NULL;
    struct pcj_result r;
    int rc = pcj_open(c->journal_fd, c->journal_id, c->model, &c->binding, &c->checkpoint, &j, &r);
    /* Caller fd is closed/reused: journal must own an independent description. */
    if (close(c->journal_fd)) return -1;
    c->journal_fd = -1;
    if (rc) { printf("{\"event\":\"open-error\",\"error\":%d}\n", r.error); return 0; }
    state_event("ready", j);
    fault = c->requested_fault; sync_calls = write_calls = close_calls = 0;
    char line[128];
    while (fgets(line, sizeof(line), stdin)) {
        unsigned long long gen;
        unsigned int event;
        if (!strcmp(line, "EXIT\n")) {
            rc = pcj_close(&j, &r);
            printf("{\"event\":\"closed\",\"rc\":%d,\"error\":%d,\"closeError\":%d}\n", rc, r.error, r.close_error);
            return rc;
        }
        if (!strcmp(line, "CHECK\n")) {
            printf("{\"event\":\"checked\",\"rc\":%d}\n", pg_check(guard)); continue;
        }
        if (sscanf(line, "%u %llu", &event, &gen) != 2) return -1;
        unsigned char evidence[32]; memset(evidence, 0x42, sizeof(evidence));
        rc = pcj_record(j, (uint64_t)gen, (enum pcj_event)event, evidence, &r);
        printf("{\"event\":\"record\",\"rc\":%d,\"outcome\":%d,\"error\":%d,\"closeError\":%d,"
               "\"syncCalls\":%d,\"closeCalls\":%d,\"reuseAlive\":%d}\n",
               rc, r.outcome, r.error, r.close_error, sync_calls, close_calls,
               reused >= 0 && fcntl(reused, F_GETFD) >= 0);
        state_event("state", j);
    }
    /* Disconnect: persist incomplete if possible, then guard fail-stops. */
    struct pcj_state s;
    if (!pcj_snapshot(j, &s) && s.head.owner_generation && !s.complete)
        (void)pcj_record(j, s.head.owner_generation, PCJ_INCOMPLETE, NULL, &r);
    state_event("disconnected", j);
    errno = ECANCELED;
    return -1;
}
static struct pg_identity identity(int fd) {
    struct stat s;
    if (fstat(fd, &s)) _exit(91);
    return (struct pg_identity){s.st_dev, s.st_ino, s.st_uid};
}
int main(int argc, char **argv) {
    if (argc != 8) return 64;
    setvbuf(stdout, NULL, _IONBF, 0);
    struct context c = {0};
    strcpy(c.binding.upgrade_id, "upgrade-test");
    memset(c.binding.context_digest, 0x23, 32);
    c.binding.old_present = 1; c.binding.old_size = 3; c.binding.target_size = 3;
    memcpy(c.binding.old_bytes, "old", 3); memcpy(c.binding.target_bytes, "new", 3);
    if (!strcmp(argv[7], "changed-binding")) c.binding.target_bytes[0] = 'X';
    c.checkpoint.sequence = strtoull(argv[2], NULL, 10);
    c.checkpoint.owner_generation = strtoull(argv[3], NULL, 10);
    if (strlen(argv[4]) != 64) return 64;
    for (int i = 0; i < 32; i++) {
        unsigned int value;
        if (sscanf(argv[4] + 2*i, "%2x", &value) != 1) return 64;
        c.checkpoint.digest[i] = (unsigned char)value;
    }
    c.model = atoi(argv[5]); c.requested_fault = strcmp(argv[6], "none") ? argv[6] : NULL;
    int parent = open(argv[1], O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (parent < 0) return 65;
    int index = openat(parent, "index", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    c.journal_fd = openat(parent, "journal", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (index < 0 || c.journal_fd < 0) return 66;
    struct pg_identity p = identity(parent), d = identity(index);
    c.journal_id = identity(c.journal_fd);
    if (close(index)) return 67;
    struct pg_result result;
    int rc = pg_controller_run(parent, "index", p, d, 0, work, &c, &result);
    printf("{\"event\":\"guard-result\",\"rc\":%d,\"error\":%d}\n", rc, result.error);
    if (close(parent)) return 68;
    return rc ? 70 : 0;
}
