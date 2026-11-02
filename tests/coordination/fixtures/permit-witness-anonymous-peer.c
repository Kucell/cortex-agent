/* Benign, finite native child. No provider loading, credential access or tree. */
#include <CommonCrypto/CommonHMAC.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#ifndef PW_PEER_MODE
#define PW_PEER_MODE "echo"
#endif
extern char **environ;
#ifdef PW_CAPACITY_PEER
int pw_capacity_peer_run(uint64_t);
#endif
static uint64_t deadline;
static volatile sig_atomic_t resume_reader;
static void resume_signal(int sig) { (void)sig; resume_reader = 1; }
static uint64_t now_ns(void) {
    struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t)) _exit(90);
    return (uint64_t)t.tv_sec * 1000000000ULL + (uint64_t)t.tv_nsec;
}
static void nap(void) { struct timespec t = { 0, 1000000 }; nanosleep(&t, NULL); }
static int transfer(int fd, unsigned char *p, size_t size, int writing) {
    size_t used = 0;
    while (used < size && now_ns() < deadline) {
        ssize_t n = writing ? write(fd, p + used, size - used) : read(fd, p + used, size - used);
        if (n > 0) used += (size_t)n;
        else if (n < 0 && (errno == EAGAIN || errno == EINTR)) nap();
        else return 0;
    }
    return used == size;
}
static int send_frame(const unsigned char *p, size_t n) {
    unsigned char header[4] = { (unsigned char)(n >> 24), (unsigned char)(n >> 16),
        (unsigned char)(n >> 8), (unsigned char)n };
    return transfer(4, header, 4, 1) && transfer(4, (unsigned char *)p, n, 1);
}
static size_t receive_frame(unsigned char *p) {
    unsigned char h[4]; if (!transfer(3, h, 4, 0)) return 0;
    size_t n = ((size_t)h[0] << 24) | ((size_t)h[1] << 16) | ((size_t)h[2] << 8) | h[3];
    if (!n || n > 512 || !transfer(3, p, n, 0)) return 0;
    return n;
}
static void wipe(void *p, size_t n) { volatile unsigned char *v = p; while (n--) *v++ = 0; }
int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1 || environ[0]) return 10;
    if (!strcmp(PW_PEER_MODE, "inheritance-probe")) {
        for (int fd = 3; fd < getdtablesize(); fd++) {
            int flags = fcntl(fd, F_GETFD);
            if (fd == 64) {
                struct stat st;
                if (flags != 0 || fstat(fd,&st) || !S_ISCHR(st.st_mode) ||
                    (fcntl(fd,F_GETFL) & O_ACCMODE) != O_RDONLY) return 30;
            } else if (flags >= 0 || errno != EBADF) return 25;
        }
        return 0;
    }
    if (chdir("/") || fcntl(4, F_SETNOSIGPIPE, 1)) return 11;
    /* Full descriptor inventory, including deliberately non-CLOEXEC sentinels
     * in the parent: only stdio and the three mapped capabilities may exist. */
    for (int fd = 3; fd < getdtablesize(); fd++) {
        int flags = fcntl(fd, F_GETFL);
        if (fd >= 6) { if (flags >= 0 || errno != EBADF) return 12; continue; }
        struct stat st;
        if (flags < 0 || !(flags & O_NONBLOCK) ||
            (flags & O_ACCMODE) != (fd == 4 ? O_WRONLY : O_RDONLY) ||
            fstat(fd, &st) || !S_ISFIFO(st.st_mode) || st.st_nlink != 0) return 13;
    }
    deadline = now_ns() + 4000000000ULL;
    unsigned char bootstrap[56];
    if (!transfer(5, bootstrap, 56, 0)) return 14;
    uint64_t parent_deadline = 0;
    for (size_t i = 0; i < 8; i++) parent_deadline = (parent_deadline << 8) | bootstrap[48+i];
    if (parent_deadline <= now_ns() || parent_deadline > deadline + 1000000000ULL) return 15;
    deadline = parent_deadline;
    unsigned char extra;
    ssize_t n;
    do { n = read(5, &extra, 1); if (n < 0 && errno == EAGAIN) nap(); }
    while (n < 0 && (errno == EINTR || errno == EAGAIN) && now_ns() < deadline);
    if (n != 0 || close(5)) return 16; /* precise 56 bytes and immediate EOF */
    unsigned char input[77], mac[32];
    memcpy(input, "PW_ANONYMOUS_DEV_ACK:", 21); memcpy(input+21, bootstrap, 56);
    CCHmac(kCCHmacAlgSHA256, bootstrap, 32, input, sizeof(input), mac);
    wipe(input, sizeof(input)); wipe(bootstrap, sizeof(bootstrap));
    if (!strcmp(PW_PEER_MODE, "bad-ack")) mac[0] ^= 1;
    if (!send_frame(mac, 32)) return 17;
    wipe(mac, sizeof(mac));
    if (!strcmp(PW_PEER_MODE, "bad-ack")) return 0;
    if (!strcmp(PW_PEER_MODE, "oversize")) {
        unsigned char header[4] = { 0x7f, 0xff, 0xff, 0xff };
        return transfer(4, header, 4, 1) ? 0 : 18;
    }
    if (!strcmp(PW_PEER_MODE, "truncated")) {
        unsigned char partial[6] = { 0, 0, 0, 10, 1, 2 };
        return transfer(4, partial, sizeof(partial), 1) ? 0 : 19;
    }
    if (!strcmp(PW_PEER_MODE, "eof")) return 0;
    struct sigaction sa; memset(&sa, 0, sizeof(sa)); sa.sa_handler = resume_signal;
    sigemptyset(&sa.sa_mask);
    if (sigaction(SIGUSR1, &sa, NULL)) return 20;
    if (!strcmp(PW_PEER_MODE, "close-read") && close(3)) return 21;
    if (!send_frame((const unsigned char *)"FD_OK", 5)) return 22;
#ifdef PW_CAPACITY_PEER
    return pw_capacity_peer_run(deadline);
#endif
    if (!strcmp(PW_PEER_MODE, "expect-zero") || !strcmp(PW_PEER_MODE, "expect-nine")) {
        unsigned char bytes[32]; size_t received = 0;
        while (now_ns() < deadline) {
            ssize_t n = read(3, bytes, sizeof(bytes));
            if (n > 0) { received += (size_t)n; if (received > 9) return 26; }
            else if (!n) return received == (!strcmp(PW_PEER_MODE,"expect-nine") ? 9u : 0u) ? 0 : 27;
            else if (errno == EAGAIN || errno == EINTR) nap();
            else return 28;
        }
        return 29;
    }
    if (!strcmp(PW_PEER_MODE, "stall") || !strcmp(PW_PEER_MODE, "close-read")) {
        while (now_ns() < deadline) nap(); return 0;
    }
    if (!strcmp(PW_PEER_MODE,"hup-drain")) {
        unsigned char bytes[512];size_t count=receive_frame(bytes);
        if(count!=512||!send_frame(bytes,count)||close(4))return 31;
        // Keep the process alive so HUP proves the response writer closed,
        // independently of direct-child exit or implicit exit cleanup.
        while(now_ns()<deadline)nap();return 0;
    }
    if (!strcmp(PW_PEER_MODE, "paused")) {
        /* Signal handler installed and request fd open: FD_OK is the barrier.
         * No request read happens until parent observes kernel EAGAIN. */
        while (!resume_reader && now_ns() < deadline) nap();
        if (!resume_reader) return 0;
        unsigned char bytes[512]; size_t count;
        while ((count = receive_frame(bytes)) != 0) {
            if (count == 10 && !memcmp(bytes, "RESUME_END", 10))
                return send_frame((const unsigned char *)"DRAINED", 7) ? 0 : 23;
        }
        return 24;
    }
    unsigned char bytes[512]; size_t count;
    while ((count = receive_frame(bytes)) != 0) {
        if (!send_frame(bytes, count)) break;
    }
    wipe(bytes, sizeof(bytes)); return 0;
}
