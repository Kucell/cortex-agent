#ifndef PERMIT_SQLITE_OBSERVER_HOOKS_H
#define PERMIT_SQLITE_OBSERVER_HOOKS_H
#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
int pso_test_openat(int, const char *, int, ...);
int pso_test_fstatat(int, const char *, struct stat *, int);
int pso_test_fstat(int, struct stat *);
ssize_t pso_test_pread(int, void *, size_t, off_t);
int pso_test_close(int);
#define openat pso_test_openat
#define fstatat pso_test_fstatat
#define fstat pso_test_fstat
#define pread pso_test_pread
#define close pso_test_close

/* <fcntl.h> is included above, before the redirection macros, for two
 * reasons.
 *
 * First, glibc redirects the file APIs to their 64-bit spellings when the
 * translation unit is built with _FILE_OFFSET_BITS=64 — which the Ubuntu
 * toolchains enable by default. It does so with macros in <fcntl.h> and
 * <sys/stat.h>. Because the observer includes <fcntl.h> after this hook, a
 * redirection defined here would be overwritten by glibc's own, and the
 * observer would call the real kernel entry points instead of the
 * instrumented ones. The observer would then report a verdict derived from
 * whatever the filesystem happened to hold, not from the sequence the
 * fixture staged — the race cases would silently stop testing the race.
 * Including <fcntl.h> first means glibc's redirection is already in place
 * when the macros below are defined, so these definitions are the ones that
 * survive.
 *
 * Second, the 64-bit spellings are covered explicitly, so the redirection
 * holds whether or not the toolchain enables it. The fixture's own
 * translation unit is compiled without this hook, so each variant reaches
 * the real syscall and no recursion is possible. */
#define openat64 pso_test_openat
#define fstatat64 pso_test_fstatat
#define fstat64 pso_test_fstat
#define pread64 pso_test_pread
#endif
