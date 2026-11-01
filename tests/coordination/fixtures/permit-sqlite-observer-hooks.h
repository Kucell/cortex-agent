#ifndef PERMIT_SQLITE_OBSERVER_HOOKS_H
#define PERMIT_SQLITE_OBSERVER_HOOKS_H
#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
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
#endif
