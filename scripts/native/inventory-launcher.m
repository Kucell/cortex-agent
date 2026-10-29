// Trusted release launcher: fixed worker identity is compiled after worker signing.
// No runtime executable/requirement override; unconfigured builds fail closed.
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <CommonCrypto/CommonDigest.h>
#include <mach-o/dyld.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <spawn.h>
#include <poll.h>
#include <signal.h>
#include <fcntl.h>
#include <unistd.h>
#include <time.h>
#include <errno.h>
#ifndef INVENTORY_WORKER_TEAM
#define INVENTORY_WORKER_TEAM ""
#define INVENTORY_WORKER_CDHASH ""
#define INVENTORY_WORKER_REQUIREMENT ""
#endif
#ifndef INVENTORY_WORKER_SIZE
#define INVENTORY_WORKER_SIZE 0
#define INVENTORY_WORKER_SHA256 ""
#endif
static volatile sig_atomic_t cancelled = 0;
static uint64_t started;
static void cancelHandler(int signalNumber) { (void)signalNumber; cancelled = 1; }
static pid_t child = -1;
static void reap(void) {
  if (child <= 0) return;
  kill(child, SIGTERM);
  for (int i = 0; i < 100; i++) {
    pid_t r = waitpid(child, NULL, WNOHANG);
    if (r == child || (r < 0 && errno == ECHILD)) { child = -1; return; }
    usleep(10000);
  }
  kill(child, SIGKILL); while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {} child = -1;
}
static void fail(const char *code) { reap(); fprintf(stderr, "%s\n", code); exit(2); }
static uint64_t nowMs(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return (uint64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000; }
static void deadline(void) {
  if (cancelled) fail("MIGRATION_NATIVE_CANCELLED");
  if (nowMs() - started >= 30000) fail("MIGRATION_NATIVE_TIMEOUT");
}
static void validateFile(NSString *worker) {
  int fd = open(worker.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  struct stat before, after;
  if (fd < 0 || fstat(fd, &before) || !S_ISREG(before.st_mode) || before.st_nlink != 1 || (before.st_mode & 022) ||
      before.st_size != INVENTORY_WORKER_SIZE || before.st_size > 40 * 1024 * 1024) fail("MIGRATION_NATIVE_HASH_INVALID");
  CC_SHA256_CTX hash; CC_SHA256_Init(&hash); unsigned char buffer[65536], result[CC_SHA256_DIGEST_LENGTH]; off_t bytes = 0;
  for (;;) { deadline(); ssize_t n = read(fd, buffer, sizeof(buffer)); if (n < 0 && errno == EINTR) continue;
    if (n < 0) fail("MIGRATION_NATIVE_HASH_INVALID"); if (!n) break; bytes += n;
    if (bytes > before.st_size) fail("MIGRATION_NATIVE_HASH_INVALID"); CC_SHA256_Update(&hash, buffer, (CC_LONG)n); }
  CC_SHA256_Final(result, &hash); NSMutableString *hex = [NSMutableString string];
  for (NSUInteger i = 0; i < sizeof(result); i++) [hex appendFormat:@"%02x", result[i]];
  if (fstat(fd, &after) || bytes != before.st_size || before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
      before.st_size != after.st_size || before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec ||
      before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec || ![hex isEqualToString:@INVENTORY_WORKER_SHA256]) fail("MIGRATION_NATIVE_HASH_INVALID");
  close(fd);
  SecStaticCodeRef code = NULL; SecRequirementRef requirement = NULL;
  NSURL *url = [NSURL fileURLWithPath:worker];
  if (SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags, &code) != errSecSuccess ||
      SecRequirementCreateWithString(CFSTR(INVENTORY_WORKER_REQUIREMENT), kSecCSDefaultFlags, &requirement) != errSecSuccess ||
      SecStaticCodeCheckValidity(code, kSecCSStrictValidate, requirement) != errSecSuccess) fail("MIGRATION_NATIVE_SIGNATURE_INVALID");
  CFRelease(requirement); CFRelease(code); deadline();
}
static void validateChild(void) {
  // Never reap this direct child before verification: its PID cannot be reused.
  int pid = child; CFNumberRef number = CFNumberCreate(NULL, kCFNumberIntType, &pid);
  const void *keys[] = { kSecGuestAttributePid }, *values[] = { number };
  CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  SecCodeRef code = NULL; SecStaticCodeRef staticCode = NULL; SecRequirementRef requirement = NULL; CFDictionaryRef info = NULL;
  OSStatus status = SecCodeCopyGuestWithAttributes(NULL, attrs, kSecCSDefaultFlags, &code);
  CFRelease(attrs); CFRelease(number);
  if (status != errSecSuccess) fail("MIGRATION_NATIVE_PROCESS_IDENTITY");
  status = SecRequirementCreateWithString(CFSTR(INVENTORY_WORKER_REQUIREMENT), kSecCSDefaultFlags, &requirement);
  if (status != errSecSuccess || SecCodeCheckValidity(code, kSecCSStrictValidate, requirement) != errSecSuccess)
    fail("MIGRATION_NATIVE_SIGNATURE_INVALID");
  if (SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &staticCode) != errSecSuccess ||
      SecCodeCopySigningInformation(staticCode, kSecCSSigningInformation, &info) != errSecSuccess)
    fail("MIGRATION_NATIVE_SIGNATURE_INVALID");
  CFStringRef team = CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier);
  CFDataRef hash = CFDictionaryGetValue(info, kSecCodeInfoUnique);
  if (!team || CFGetTypeID(team) != CFStringGetTypeID() || !CFEqual(team, CFSTR(INVENTORY_WORKER_TEAM)) ||
      !hash || CFGetTypeID(hash) != CFDataGetTypeID()) fail("MIGRATION_NATIVE_SIGNATURE_INVALID");
  NSMutableString *hex = [NSMutableString string];
  for (CFIndex i = 0; i < CFDataGetLength(hash); i++) [hex appendFormat:@"%02x", CFDataGetBytePtr(hash)[i]];
  if (![hex isEqualToString:@INVENTORY_WORKER_CDHASH]) fail("MIGRATION_NATIVE_SIGNATURE_INVALID");
  CFRelease(info); CFRelease(staticCode); CFRelease(requirement); CFRelease(code);
}
static void writeAll(int fd, const void *bytes, size_t size) {
  const char *p = bytes; uint64_t last = nowMs(); int flags = fcntl(fd, F_GETFL);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK)) fail("MIGRATION_NATIVE_PIPE_FAILED");
  while (size) {
    deadline(); if (nowMs() - last >= 5000) fail("MIGRATION_NATIVE_TIMEOUT");
    struct pollfd writable = { fd, POLLOUT, 0 };
    int timeout = (int)MIN(30000 - (nowMs() - started), 5000 - (nowMs() - last));
    int ready = poll(&writable, 1, MAX(timeout, 0)); if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0) fail("MIGRATION_NATIVE_TIMEOUT");
    ssize_t n = write(fd, p, size); if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (n <= 0) fail("MIGRATION_NATIVE_PIPE_FAILED"); p += n; size -= (size_t)n; last = nowMs();
  }
  if (fcntl(fd, F_SETFL, flags)) fail("MIGRATION_NATIVE_PIPE_FAILED");
}
int main(int argc, const char **argv) { @autoreleasepool {
  (void)argv; signal(SIGPIPE, SIG_IGN); signal(SIGTERM, cancelHandler); signal(SIGINT, cancelHandler); started = nowMs();
  if (argc != 1 || !strlen(INVENTORY_WORKER_TEAM) || !strlen(INVENTORY_WORKER_CDHASH) || !strlen(INVENTORY_WORKER_REQUIREMENT) || INVENTORY_WORKER_SIZE <= 0 || !strlen(INVENTORY_WORKER_SHA256))
    fail("MIGRATION_NATIVE_RELEASE_UNAVAILABLE");
  char executable[PATH_MAX], resolved[PATH_MAX]; uint32_t length = sizeof(executable);
  if (_NSGetExecutablePath(executable, &length) || !realpath(executable, resolved)) fail("MIGRATION_NATIVE_PATH_INVALID");
  NSString *directory = [[NSString stringWithUTF8String:resolved] stringByDeletingLastPathComponent];
  NSString *worker = [directory stringByAppendingPathComponent:@"inventory-worker"];
  struct stat st;
  if (lstat(worker.fileSystemRepresentation, &st) || !S_ISREG(st.st_mode) || st.st_nlink != 1 || (st.st_mode & 022))
    fail("MIGRATION_NATIVE_PATH_INVALID");
  validateFile(worker);
  int input[2], output[2], ready[2];
  if (pipe(input) || pipe(output) || pipe(ready)) fail("MIGRATION_NATIVE_PIPE_FAILED");
  posix_spawn_file_actions_t actions; posix_spawnattr_t attributes;
  if (posix_spawn_file_actions_init(&actions) || posix_spawnattr_init(&attributes) ||
      posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT) ||
      posix_spawn_file_actions_adddup2(&actions, input[0], 0) ||
      posix_spawn_file_actions_adddup2(&actions, output[1], 1) ||
      posix_spawn_file_actions_adddup2(&actions, 2, 2) ||
      posix_spawn_file_actions_adddup2(&actions, ready[1], 3) ||
      posix_spawn_file_actions_addchdir_np(&actions, directory.fileSystemRepresentation)) fail("MIGRATION_NATIVE_SPAWN_FAILED");
  char *const args[] = { (char *)worker.fileSystemRepresentation, "--authenticated-worker", NULL };
  char *const env[] = { "PATH=/usr/bin:/bin", "LANG=C", NULL };
  int spawnError = posix_spawn(&child, worker.fileSystemRepresentation, &actions, &attributes, args, env);
  posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes);
  if (spawnError) { child = -1; fail("MIGRATION_NATIVE_SPAWN_FAILED"); }
  close(input[0]); close(output[1]); close(ready[1]);
  struct pollfd notification = { ready[0], POLLIN, 0 }; unsigned char marker;
  if (poll(&notification, 1, 5000) <= 0 || read(ready[0], &marker, 1) != 1 || marker != 1) fail("MIGRATION_NATIVE_NOT_READY");
  close(ready[0]); deadline(); validateChild(); deadline(); // No project path has reached the worker.
  NSMutableData *request = [NSMutableData data]; unsigned char buffer[65536]; uint64_t start = nowMs();
  for (;;) {
    deadline(); struct pollfd in = { STDIN_FILENO, POLLIN, 0 };
    if (nowMs() - start >= 5000 || poll(&in, 1, 5000) <= 0) fail("MIGRATION_NATIVE_REQUEST_TIMEOUT");
    ssize_t n = read(0, buffer, 8192); if (n < 0 && errno == EINTR) continue; if (n < 0) fail("MIGRATION_BAD_REQUEST");
    if (!n) break; [request appendBytes:buffer length:(NSUInteger)n]; if (request.length > 8192) fail("MIGRATION_BAD_REQUEST");
  }
  writeAll(input[1], request.bytes, request.length); close(input[1]);
  uint64_t total = 0, last = nowMs(); start = last;
  for (;;) {
    deadline(); uint64_t now = nowMs(); if (now - start >= 30000 || now - last >= 5000) fail("MIGRATION_NATIVE_TIMEOUT");
    struct pollfd out = { output[0], POLLIN, 0 }; int timeout = (int)MIN(30000 - (now - start), 5000 - (now - last));
    int p = poll(&out, 1, timeout); if (p < 0 && errno == EINTR) continue; if (p <= 0) fail("MIGRATION_NATIVE_TIMEOUT");
    ssize_t n = read(output[0], buffer, sizeof(buffer)); if (n < 0 && errno == EINTR) continue;
    if (n < 0) fail("MIGRATION_NATIVE_PIPE_FAILED"); if (!n) break;
    total += (uint64_t)n; if (total > 96 * 1024 * 1024) fail("MIGRATION_INVENTORY_LIMIT");
    writeAll(1, buffer, (size_t)n); last = nowMs();
  }
  close(output[0]); int status = 0; BOOL exited = NO;
  for (int i = 0; i < 100; i++) { if (waitpid(child, &status, WNOHANG) == child) { exited = YES; break; } usleep(10000); }
  if (!exited) fail("MIGRATION_NATIVE_EXIT_TIMEOUT"); child = -1;
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) fail("MIGRATION_NATIVE_WORKER_FAILED");
  return 0;
} }
