/* Linked only into instrumented test artifacts. Core source is unchanged. */
#include <assert.h>
#include <fcntl.h>
#include <pthread.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
static void check_io(int fd) {
    assert(!pthread_main_np());
    int flags = fcntl(fd,F_GETFL); assert(flags >= 0 && (flags & O_NONBLOCK));
}
ssize_t pw_napi_test_read(int fd, void *bytes, size_t n) {
    check_io(fd); assert(n > 0 && n <= 4096); return read(fd,bytes,n);
}
ssize_t pw_napi_test_write(int fd, const void *bytes, size_t n) {
    check_io(fd); assert(n > 0 && n <= 4096); return write(fd,bytes,n);
}
pid_t pw_napi_test_waitpid(pid_t pid, int *status, int options) {
    assert(!pthread_main_np() && options == WNOHANG); return waitpid(pid,status,options);
}
int pw_napi_test_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
    const posix_spawnattr_t *attr, char *const argv[], char *const env[]) {
    assert(!pthread_main_np()); return posix_spawn(pid,path,actions,attr,argv,env);
}
