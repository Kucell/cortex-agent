#ifndef PERMIT_UPGRADE_LINUX_GUARD_H
#define PERMIT_UPGRADE_LINUX_GUARD_H

#include <sys/types.h>

/* Lock primitive only: no registration, negative discovery or write authority. */
struct pg_identity { dev_t device; ino_t inode; uid_t owner; };
struct pg_guard;
typedef int (*pg_controller_work)(const struct pg_guard *, void *);

enum pg_lock_state { PG_NOT_ACQUIRED, PG_HELD, PG_RELEASED, PG_RELEASE_UNKNOWN };
/* Caller-owned live diagnostics, not a durable record or authorization ticket.
 * STARTED work may already have published, even if it never returns 0.
 * work_completed means work returned 0, NOT that final check/cleanup succeeded.
 * error is the first error; close errors are also retained separately. */
struct pg_result {
    int work_started, work_completed, error;
    int check_close_error, lock_close_error, parent_close_error;
    enum pg_lock_state lock_state;
};

/* parent_fd is a trusted, already bound directory. relative is resolved beneath
 * it without symlinks or mount crossings. Both identities are mandatory.
 * The library independently opens and owns its descriptions (never exports the
 * lock FD). exclusive is for coordination testing/future installers, NOT proof
 * that registration or old-writer drainage is safe.
 *
 * work runs synchronously IN THIS PROCESS, under the lock. It must not create
 * workers/threads or return while any work remains. Return 0 only after all
 * work/finalization is complete; any other return fail-stops with lock held until
 * process death. No cancellation/unlock API. result is required and must remain
 * alive throughout the call (including fail-stop). Never inspect it concurrently.
 * Acquisition/cleanup errors return -1, errno=result->error. Cleanup always
 * attempts each owned FD once, never retries even EINTR: an error can mean that
 * the number was already reused. A failed lock close means RELEASE_UNKNOWN,
 * not HELD or RELEASED; callers must not resume or roll back completed work.
 * Only fully checked work AND successful cleanup return 0.
 */
int pg_controller_run(int parent_fd, const char *relative,
                      struct pg_identity parent, struct pg_identity directory,
                      int exclusive, pg_controller_work work, void *context,
                      struct pg_result *result);
/* Diagnostic check inside work, never an authorization ticket. */
int pg_check(const struct pg_guard *guard);

#endif
