#ifndef PERMIT_CONTROL_JOURNAL_H
#define PERMIT_CONTROL_JOURNAL_H

#include "guard.h"
#include <stddef.h>
#include <stdint.h>

#define PCJ_BYTES 256
#define PCJ_WIRE_BYTES 1024
#define PCJ_MAX_RECORDS 4096

/* Storage primitive, NOT platform qualification, discovery or write authority.
 * No path-based bootstrap: fd must already designate a dedicated protected
 * journal directory. It must never be replaced/unlinked or rolled back by any
 * participating principal. All writers use this inode's EX flock.
 * Trusted controller/bootstrap, external checkpoint provenance, writer drainage
 * and continuous discovery guard are caller obligations; see journal README.
 */
struct pcj_binding {
    char upgrade_id[64];
    unsigned char context_digest[32];
    uint32_t old_present, old_size, target_size;
    unsigned char old_bytes[PCJ_BYTES], target_bytes[PCJ_BYTES];
};
struct pcj_head {
    uint64_t sequence, owner_generation;
    unsigned char digest[32];
};
enum pcj_event {
    PCJ_OWNER = 1, PCJ_INCOMPLETE, PCJ_ELIGIBLE, PCJ_CALL_POSSIBLE,
    PCJ_STAMP_CONFIRMED, PCJ_REPORT_CONFIRMED, PCJ_COMPLETE,
    PCJ_REVALIDATED, PCJ_DELIVERY_UNKNOWN
};
enum pcj_stamp { PCJ_NOT_ATTEMPTED, PCJ_STAMP_UNKNOWN, PCJ_STAMP_KNOWN };
enum pcj_outcome { PCJ_NOT_WRITTEN, PCJ_WRITE_UNKNOWN, PCJ_SYNC_OBSERVED };
struct pcj_state {
    struct pcj_head head;
    uint64_t attempt;
    enum pcj_stamp stamp;
    int incomplete, eligible, report_confirmed, complete, delivery_unknown;
};
struct pcj_result {
    enum pcj_outcome outcome;
    int error, close_error;
};
struct pcj;

/* Independently opens fd/"." with openat2, checks exact identity, acquires
 * nonblocking EX flock, validates every record and compares the EXACT head to
 * the controller's out-of-domain checkpoint. Every reopened handle must record
 * a higher OWNER before any mutation; replay never restores live ownership.
 * Zero checkpoint means a NEW empty
 * journal, never "missing means safe". Any orphan/torn/unacknowledged tail,
 * gap, extra name, stale checkpoint or corrupt bytes blocks opening.
 * model=0: root-owned ext4/XFS/Btrfs storage checks only, NOT authentication.
 * model=1: permits caller-owned tmpfs too, exclusively for explicit test models.
 * Neither mode certifies controller provenance, durable hardware or antirollback.
 */
int pcj_open(int fd, struct pg_identity identity, int model,
             const struct pcj_binding *binding, const struct pcj_head *checkpoint,
             struct pcj **out, struct pcj_result *result);

/* Records a trusted controller's decision, does not verify its truth. Evidence
 * digest required for eligible/revalidated/confirmed/report/complete. No callback
 * or request can self-certify qualification. OWNER must strictly increase the
 * generation and invalidates eligibility; every other event uses exact current
 * generation. Unknown stamp survives takeover and revalidation, until an
 * independently verified confirmation. REVALIDATED requires a new owner since
 * CALL_POSSIBLE/INCOMPLETE. COMPLETE requires stamp + report confirmations.
 *
 * Exclusive create, full write/readback, file fsync, named-byte verification,
 * directory fsync, single closes. Once creation is attempted any failure poisons
 * this handle; result is UNKNOWN. Never retries publication, unlinks or repairs.
 * A successful result MUST be checkpointed in the trusted control domain before
 * any dependent external effect. Lost checkpoint ack => blocked reconciliation,
 * never accept a disk-derived head as its own authorization.
 */
int pcj_record(struct pcj *, uint64_t generation, enum pcj_event,
               const unsigned char evidence_digest[32], struct pcj_result *);
int pcj_snapshot(const struct pcj *, struct pcj_state *);

/* Bounded reconciliation interface. No writable handle is obtained by observing
 * a disk head. anchor must come from the independent control/witness domain;
 * fence_generation and revision are its durable owner fence and CAS revision.
 * The witness must independently establish old-writer drainage, no late rename,
 * same upgrade/target/deployment, original migration/activation and live safety
 * continuity. A local chain/hash, uid, data field or boolean proves none of this.
 *
 * open holds a private EX directory lock even for a classified damaged tail.
 * prepare fsyncs/byte-checks the complete bounded chain without changing bytes;
 * copy_tail exports only complete, chain-checked unacknowledged records.
 * Torn/corrupt/gapped/unanchored/over-bound tails cannot prepare or accept.
 * Unknown bytes are never truncated, skipped, overwritten or deleted.
 */
#define PCJ_RECOVERY_LIMIT 64
#define PCJ_RECOVERY_REQUEST_BYTES 1152
#define PCJ_RECOVERY_RECEIPT_BYTES 128
enum pcj_tail_kind {
    PCJ_TAIL_COMPLETE = 1, PCJ_TAIL_TORN, PCJ_TAIL_INVALID,
    PCJ_TAIL_PREFIX_UNPROVEN, PCJ_TAIL_OVER_BOUND, PCJ_TAIL_IO_UNKNOWN
};
enum pcj_cas_state { PCJ_CAS_UNAVAILABLE, PCJ_CAS_COMMITTED, PCJ_CAS_REJECTED, PCJ_CAS_UNKNOWN };
struct pcj_anchor {
    struct pcj_head head;
    uint64_t revision, fence_generation;
};
struct pcj_recovery_view {
    enum pcj_tail_kind kind;
    int prefix_verified;
    uint64_t records, bad_sequence;
    struct pcj_state observed; /* observation only, NEVER authorization */
};
struct pcj_recovery;
int pcj_recovery_open(int fd, struct pg_identity, int model,
                      const struct pcj_binding *, const struct pcj_anchor *,
                      uint64_t next_generation, uint64_t max_tail,
                      struct pcj_recovery **, struct pcj_recovery_view *, struct pcj_result *);
int pcj_recovery_prepare(struct pcj_recovery *,
                         unsigned char request[PCJ_RECOVERY_REQUEST_BYTES], struct pcj_result *);
int pcj_recovery_copy_tail(struct pcj_recovery *, uint64_t sequence,
                           unsigned char wire[PCJ_WIRE_BYTES], struct pcj_result *);
/* Receipt wire: PCJRA001, request SHA256[32], CAS state LE64, new revision LE64,
 * reserved next owner LE64; Ed25519 signature[64] over preceding 64 bytes.
 * The external witness CAS binds the exact old anchor, bounded observed head,
 * request nonce and reserved next owner; receipts are not general capabilities.
 * COMMITTED means this exact head adoption AND owner reservation are durable.
 * UNKNOWN (including lost reply) keeps the same request/session, no local writes,
 * no writable handle. Query the witness by request digest; never repeat effects.
 * After death a new nonce requires independent authoritative CAS reconciliation.
 *
 * DEFAULT BUILD HAS NO TRUST ANCHOR/VERIFIER AND RETURNS EOPNOTSUPP. It cannot
 * authenticate a platform or grant recovery. There is intentionally no caller
 * key, callback, boolean or "qualified" input. The sole verifier presently
 * available is a separately compiled PCJ_TEST_WITNESS_KEY_HEX test model, which
 * also requires model=1. A real fixed trusted verifier/controller remains an
 * integration prerequisite, not an implemented production adapter.
 *
 * A verified MODEL receipt adopts all bytes, never auto-confirms stamp or changes
 * original outcomes. Returned handle must append exactly the reserved higher
 * OWNER, revalidate, then follow the existing checkpoint-before-effect contract.
 * CAS revision/owner reservation must remain in the independent witness domain.
 */
int pcj_recovery_accept(struct pcj_recovery **,
                        const unsigned char receipt[PCJ_RECOVERY_RECEIPT_BYTES],
                        struct pcj **, enum pcj_cas_state *, struct pcj_result *);
int pcj_recovery_close(struct pcj_recovery **, struct pcj_result *);
/* Single close; consumes *journal even on error. No retry after EINTR. */
int pcj_close(struct pcj **journal, struct pcj_result *result);

#endif
