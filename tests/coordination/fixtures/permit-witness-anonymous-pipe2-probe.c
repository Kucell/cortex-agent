/* Link-time test seam: only anonymous.c has pipe/pipe2 names redirected here.
 * No callbacks, fd export or arbitrary spawn configuration in the capability. */
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
#ifndef PW_FIXED_INHERITANCE_PROBE
#error "fixed benign descriptor-inventory executable required"
#endif
static unsigned checked_pairs, checked_spawns;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed = PTHREAD_COND_INITIALIZER;
static int spawned;
static void *broad_spawn(void *unused) {
    (void)unused;
    char *const argv[] = { (char *)PW_FIXED_INHERITANCE_PROBE, NULL };
    char *const env[] = { NULL };
    pid_t pid; int status;
    // Deliberately NO CLOEXEC_DEFAULT and NO file actions: pipe creation must
    // protect itself against unrelated ordinary inheriting launches.
    assert(posix_spawn(&pid, PW_FIXED_INHERITANCE_PROBE, NULL, NULL, argv, env) == 0);
    assert(waitpid(pid, &status, 0) == pid);
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
    assert(pthread_mutex_lock(&lock) == 0);
    spawned = 1;
    assert(pthread_cond_signal(&changed) == 0);
    assert(pthread_mutex_unlock(&lock) == 0);
    return NULL;
}
int pw_test_forbidden_pipe(int pair[2]) {
    (void)pair; assert(!"pipe fallback is forbidden"); return -1;
}
int pw_test_pipe2(int pair[2], int flags) {
    assert(flags == (O_CLOEXEC | O_NONBLOCK));
#ifdef PW_PIPE2_ENOSYS
    (void)pair; errno = ENOSYS; return -1;
#else
    int rc = pipe2(pair, flags);
    assert(rc == 0);
    // Inspect before native prepare_pipe can perform any fcntl operation.
    for (int i = 0; i < 2; i++) {
        assert(fcntl(pair[i], F_GETFD) == FD_CLOEXEC);
        assert(fcntl(pair[i], F_GETFL) & O_NONBLOCK);
    }
    checked_pairs++;
    // Positive control: this unrelated, non-secret descriptor MUST inherit.
    // A default-close-all launcher would otherwise make the negative probe
    // vacuously green. The inventory child requires fd 64 and rejects all other
    // non-stdio descriptors, including both freshly created pipe endpoints.
    int null_fd = open("/dev/null", O_RDONLY | O_CLOEXEC); assert(null_fd >= 0);
    int control = fcntl(null_fd, F_DUPFD, 64); assert(control == 64);
    assert(close(null_fd) == 0 && fcntl(control, F_GETFD) == 0);
    pthread_t thread; spawned = 0;
    assert(pthread_mutex_lock(&lock) == 0);
    assert(pthread_create(&thread, NULL, broad_spawn, NULL) == 0);
    while (!spawned) assert(pthread_cond_wait(&changed, &lock) == 0);
    assert(pthread_mutex_unlock(&lock) == 0);
    assert(pthread_join(thread, NULL) == 0);
    assert(close(control) == 0);
    checked_spawns++;
    return rc;
#endif
}
void pw_test_check_pipe2(unsigned expected) {
    assert(checked_pairs == expected && checked_spawns == expected);
}
