#ifndef PERMIT_SQLITE_OBSERVER_H
#define PERMIT_SQLITE_OBSERVER_H

#include <stdint.h>
#include <sys/types.h>

struct pso_identity { dev_t device; ino_t inode; uid_t owner; };
enum pso_state {
    PSO_OBSERVED, PSO_MISSING, PSO_INVALID_INPUT, PSO_IDENTITY_UNKNOWN,
    PSO_UNSAFE_UNKNOWN, PSO_CHANGED_UNKNOWN, PSO_PERMISSION_UNKNOWN,
    PSO_IO_UNKNOWN, PSO_CLOSE_UNKNOWN
};
enum pso_format {
    PSO_FORMAT_UNPROVEN, PSO_FORMAT_MISSING, PSO_CORRUPT_HEADER,
    PSO_SCHEMA1_NEEDS_MIGRATION, PSO_SCHEMA2_HEADER_ONLY,
    PSO_SCHEMA3_DEVELOPMENT_AUTHORITY_UNSUPPORTED, PSO_UNKNOWN_SCHEMA
};
enum pso_type {
    PSO_TYPE_UNKNOWN, PSO_ABSENT, PSO_REGULAR, PSO_DIRECTORY, PSO_SYMLINK,
    PSO_FIFO, PSO_SOCKET, PSO_BLOCK, PSO_CHARACTER, PSO_OTHER
};
/* Fixed, public observations only. No bytes, paths, identities, SQL, receipt,
 * capability or authorization. sidecars are ordered -wal, -shm, -journal.
 * Missing/corrupt/schema2/absent sidecars ALL remain blocked and unproven. */
struct pso_result {
    enum pso_state state;
    enum pso_format format;
    enum pso_type sidecars[3];
    int header_valid;
    int32_t user_version;
    uint32_t page_size;
    int cleanup_unknown;
    int blocked, execution_authorized, snapshot_unproven, path_binding_unproven;
};

/* R3 section 5.1: synchronous observation primitive for a FUTURE trusted
 * controller, called on its own stack while its live guard remains held.
 *
 * REQUIRED EXTERNAL PRECONDITIONS, not established by this function:
 * - controller has authenticated and owns directory_fd, its complete parent
 *   trust chain and FD provenance; directory and target identities come from
 *   the matching protected binding, never from an untrusted caller's claim;
 * - controller independently proves locks, writer isolation, mount/namespace
 *   trust, restart/drain safety and binding freshness throughout the call;
 * - no other thread/signal handler closes/reuses caller or library FDs, mutates
 *   arguments, or continues work outside that guard's lifetime.
 * Neither these arguments nor a result can authenticate a controller. There
 * is deliberately no "authenticated" boolean, provider, callback or gate.
 * This C API is not an untrusted RPC/CLI entry point or a production adapter.
 *
 * directory_fd must be an actual directory FD (AT_FDCWD is rejected), with
 * the specified identity and no group/other write bits. basename is ONE final
 * component, at most 247 bytes; no path walking, cwd, /dev/fd, or string reopen.
 * Target must match device/inode/owner, be regular, single-linked and on the
 * directory device. Before any header read, both its no-follow name and opened
 * FD are compared to the binding and metadata. Only offsets [0,100) are read;
 * sidecars receive no-follow fstatat only, never open/read/recovery.
 *
 * Returns 0 for stable observations (including missing/corrupt), -1 for
 * unknown/refusal; result is required. Errors/changes/uncertain close erase all
 * header/type hints. Owned duplicates are closed once, even on EINTR; the
 * caller's FD is never closed. No retries to obtain a passing observation.
 * Metadata checks cannot prove absence of arbitrary ABA or same-UID writes;
 * in particular, a writer can modify the SAME inode after the final pre-read
 * check and before pread. The changed header may actually be read before a
 * post-read metadata check returns PSO_CHANGED_UNKNOWN and clears the result's
 * header hints (not a claim that the bytes were never read). Identity binding
 * does not fix this race; production still requires independent writer
 * isolation for the entire observation. Guard and isolation remain
 * prerequisites. No freshness beyond the checks,
 * snapshot, schema, offline, migration, deployment or permission is proved.
 * Reads MAY update file/directory atime; timestamps are never restored.
 * Byte/syscall budgets are bounded, NOT blocking filesystem I/O latency.
 */
int pso_observe_at(int directory_fd, const char *basename,
                   struct pso_identity directory, struct pso_identity target,
                   struct pso_result *result);

#endif
