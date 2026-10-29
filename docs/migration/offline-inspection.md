# Offline migration inspection (phase 1)

`cortex-agent migration inspect --project <root>` and `migration plan` are read-only. They print JSON; exit 0 means the scoped format inspection has no unresolved findings, exit 1 reports unresolved/unsafe input, exit 2 rejects unsupported stages. They never back up, rewrite, recover, switch or activate data. `upgrade` remains unchanged.

This first reader requires Linux `/proc/self/fd`, to retain directory handles while reading and reject symlink/hardlink/path-replacement attacks. Other platforms return `MIGRATION_SAFE_READER_UNSUPPORTED`; no unsafe fallback is used. Project roots must be canonical, without symlink ancestors. Files are bounded to 8 MiB, the inventory to 64 MiB and 20,000 entries. Unsupported trees fail closed. Output includes relative paths, file modes and hashes, not record bodies.

The `.cortex-version` marker is provenance only, not a data schema version or proof of origin. Recognized product markers are 1.15.4, 1.15.6 and candidate 1.16.0; record schemas are checked separately against release-owned schemas, never project scripts. Unknown markers, records, fields and references remain unresolved. Data already in a recognized format does not require rewriting just because the product version changed.

All legacy Mission directories and table references are inventoried. A missing mission.json is unresolved; percentages do not become statuses. In the reported 43-directory/26-row shape all 43 require individual evidence. No schema, approval or owner field is invented. Fixed-path schemas/samples must match shipped bytes; indexes are validated and cross-checked.

Plans are deterministic for unchanged bytes and filesystem identity, contain no executable operations and bind the inventory digest. Re-running does not write anything. Two matching scans are drift detection, NOT proof of stopped writers or a consistent backup. `migration_eligible`, `quiescence_verified` and `executable` remain false. Relative or external references without a reviewed interpretation remain unresolved.

Permit domains outside `.agent` are not inspected. No detected store is reported as `not_detected_in_agent_scope`, never proof of global absence. Official npm 1.15.6 did not ship this store; source-preview users may have it elsewhere. SQLite/anchor candidates in scope are unresolved pending the separate protected-store adapter. This command does not open or repair their databases.

Tests include byte-exact examples extracted from pinned official 1.15.4/1.15.6 source revisions, with Git blob/SHA256 provenance. These are shipped format examples, not customer datasets or new registry downloads. Runtime v1 permit generation, verified backup, conversion, stop provider, replay protection and dual-domain switch remain separate release prerequisites. Phase 1 does not claim migration success or production switch support.
