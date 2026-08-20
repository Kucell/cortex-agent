---
name: proposal-share
description: "Export / import portable proposal packages (proposals + missions + topology + dual-repo peer volumes) for sharing proposal directories across developers and repositories; includes absolute-path tokenization, symlink rebuilding, structural validation, and /handoff integration."
type: procedure
applicable_to:
  - all
inputs: []
outputs: []
linked_skills: []
linked_rules:
  - .agent/rules/proposal-structure.md
linked_workflows:
  - .agent/workflows/handoff.md
owner: Kucell
last_verified: 2026-08-20
status: stable
---

# Proposal Package Sharing Workflow (/proposal-share)

Use `/proposal-share` when a proposal package must be shared with **another developer / another
repository / another machine**. It turns "standard directory structure + portable files" into a
one-command operation: it packages the project proposal group (with linked missions, topology, and
peer volumes of dual-repo joint proposals) into a self-contained tar.gz, and restores it to the
standard paths on the receiving side.

Typical scenario:

- **Dual-repo joint proposal**: csm-view-1 (backend/gateway) + samkoonyun-mobile (mobile) deliver
  together, each holding its own `.agent/plans/proposals/projects/<slug>/` volume; both sides must
  be shared, never just one.
- `.agent/` is usually gitignored (`git check-ignore .agent` exits 0), so **git clone/push cannot
  transport it**; use tar/zip packaging or direct directory copy.
- **Absolute paths** hard-coded in proposal docs (`cross_project_peers`, `relations.md`,
  `index.md`, topology `host_root`) break on a new machine and must be rewritten.
- The mobile side **mirrors shared decisions via symlinks** (e.g. `D-005-enforcement.md`); packaging
  flattens the links, and they must be rebuilt on the receiving side.

## Usage

```text
/proposal-share export <slug> [--out <dir>] [--peers <root,...>] [--missions <M-xxx,...>] [--handoff <file>]
/proposal-share import <package.tar.gz> [--root <dir>] [--root-map 'repo=/abs/path,...'] [--dry-run]
/proposal-share verify <package.tar.gz> [--root <dir>]
```

Runnable in any project (the engine is the single source of truth):

```bash
node .agent/scripts/proposal-share.js export --slug mobile-device-variable-cards --root .
node .agent/scripts/proposal-share.js import --package proposal-share-xxx.tar.gz --root .
node .agent/scripts/proposal-share.js verify --package proposal-share-xxx.tar.gz --root .
```

## Terms

- **Primary volume**: the current repo's `.agent/plans/proposals/projects/<slug>/`, which must have
  an `index.md` entry.
- **Peer volume**: the other side of a dual-repo joint proposal — another repo root that also hosts
  `.agent/plans/proposals/projects/<slug>/index.md`. Auto-discovered from topology
  `peers[].host_root`, frontmatter `cross_project_peers` (absolute paths), an absolute-path scan of
  the docs, or explicit `--peers`.
- **Token**: during packaging each repo's absolute root is replaced with a `@ROOT:<repo>@` placeholder
  so the package is portable; on import it is restored via `--root-map` (the primary token defaults
  to the target project root).

## EXPORT

1. Confirm the package exists and is compliant: `<root>/.agent/plans/proposals/projects/<slug>/index.md`
   must exist and `proposals/` must be non-empty (per .agent/rules/proposal-structure.md).
2. Run:
   ```bash
   node .agent/scripts/proposal-share.js export --slug <slug> --root <project-root> --out <out-dir>
   ```
   Default output: `<root>/.agent/artifacts/proposal-packages/proposal-share-<slug>-<timestamp>.tar.gz`.
3. The engine automatically:
   - Copies the primary volume (symlinks dereferenced; link info recorded in MANIFEST).
   - Discovers and copies **linked missions**: scans `.agent/missions/*/mission-plan.md` for
     references to `projects/<slug>`; or use `--missions M-xxx,M-yyy` / `--all-missions`.
   - Copies `.agent/topology/projects.json` (default on; `--with-topology`).
   - Discovers and copies **peer volumes** (including peer missions / topology) — both repo volumes
     travel together.
   - Replaces every known absolute root with `@ROOT:<repo>@` tokens and records the rewritten file list.
   - Generates `MANIFEST.json` (schema v1.0: volumes / missions / topology / symlinks / path_rewrites)
     and `README.md` (handover notes: install command, token mapping, symlinks to rebuild, export warnings).
4. To attach **runtime-state handover**, first produce the dual-format /handoff artifacts per
   `.agent/workflows/handoff.md`, then include them with `--handoff <handoff.md|json>`:
   ```bash
   node .agent/scripts/proposal-share.js export --slug <slug> --handoff .agent/handoffs/H-YYYYMMDD-HHMMSS-focus.json
   ```
5. Review the summary: volumes (must include every peer), missions, symlink count, path_rewrites,
   warnings. Resolve warnings before distribution (e.g. a wrong `--peers` path).
6. Distribute the self-contained tar.gz (no git dependency); hand over the /handoff doc separately or
   inside the package.

## IMPORT

1. Put the tar.gz in the target project (`--root`, default cwd) and dry-run first:
   ```bash
   node .agent/scripts/proposal-share.js import --package <file>.tar.gz --root <project-root> --dry-run
   ```
2. Without `--root-map`: primary volume, missions and topology install to the target project's
   standard paths; **unmapped peer volumes** are staged under
   `.agent/plans/proposals/imports/<slug>/peers/<repo>/` (tokens kept) for manual placement into the
   peer repo.
3. If the receiver also has the peer repo, merge directly to standard paths with `--root-map`
   (existing files are merged, never deleted):
   ```bash
   node .agent/scripts/proposal-share.js import --package <file>.tar.gz --root <project-root> \
     --root-map 'samkoonyun-mobile=/new/path/samkoonyun-mobile'
   ```
4. The engine automatically: structural validation (MANIFEST + index.md + proposals/) → install →
   token restore → **symlink rebuild** (per MANIFEST.symlinks with token-restored targets) → summary.
5. Existing targets without `--force` are refused; duplicate missions are skipped and reported.
6. After import, re-run `verify`, then continue from the package README / handoff Next Steps.

## VERIFY

```bash
node .agent/scripts/proposal-share.js verify --package <file>.tar.gz --root <project-root>
```

- Checks: MANIFEST schema, primary `index.md` + `proposals/` presence, missions/topology paths,
  and **token coverage** (no undeclared `@ROOT:` token may remain in the package).
- Exit 0 = distributable/installable; non-zero = fix and re-export.

## Quality Standards

- The package must be self-contained: no git, no source-machine absolute paths, no dependency on the
  original symlink targets (they are dereferenced into the archive).
- MANIFEST is the machine-readable source of truth; README is the human-readable guide; they must not
  contradict each other.
- The primary volume must satisfy the proposal-structure rule (index.md entry + proposals/).
- Import merges by default rather than overwriting: files in a mapped existing repo must never be deleted.
- Unresolved tokens (unmapped peers) must be reported explicitly, never silently dropped.
- `.agent/` runtime state (locks, branches, unmerged commits, Decisions/Waitpoints/Runs) does not
  belong in this package; it always travels via the dual-format /handoff artifacts.

## Division of Labor with /handoff

| Carrier | Responsibility |
| :--- | :--- |
| This package (tar.gz) | The proposal directories themselves: proposals / decisions / references / relations, missions, validation-contract, topology, peer volumes |
| /handoff (md+json) | Runtime state and next actions: task context, unfinished work, validation status, locks/branches, resume prompt |

Recommended flow: `/handoff create` → `/proposal-share export --handoff <file>` → receiver
`/proposal-share import` (+ `--root-map` for peers) → `/handoff resume`.