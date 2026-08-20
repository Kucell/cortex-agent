# Memory Index

> SessionStart hook auto-loads this file at startup (≤200 lines / 25KB cap).
> **Each line ≤200 chars** (Claude Code implementation-level hard cap).
> Topic files are NOT auto-loaded; the Agent reads them on demand.

## user (1/10)

- [reply-zh](user/reply-zh.md) — Always reply in Simplified Chinese (简体中文). Trigger: any user prompt or response from this user.

## feedback (3/30)
- [Pi governed launch host arguments](feedback/pi-governed-launch-host-args.md) — pi, governed-launch, host-adapter

- [Feedback example config parity](feedback/feedback-example-config-parity.md) — feedback, config, template-parity

- [MR merged plan semantic drift](feedback/mr-merged-plan-semantic-drift.md) — feedback, merge, plan-reconcile

## project (6/20)
- [Token Control Plane MS-001](project/token-control-plane-ms001.md) — token-control-plane, token-attempt, M-025, MS-001
- [M-025 Phase C parallel eval](project/m025-phase-c-parallel-eval.md) — m-025, phase-c, evaluation, gates, P-002, P-003, P-004
- [Cross-host memory handoff](project/cross-host-memory-handoff.md) — memory, cross-host, MiniMax, Qoder, Codex, Cortex Agent
- [DSH first-class adapter](project/dsh-firstclass-adapter.md) — dsh, deepseek-harness, adapter, dispatch, M-029, P-006, first-class

- [PostCommit hook not working](project/postcommit-hook-incompat.md) — 2026-07-21 触发，关键词：PostCommit, settings.json, hook, cortex-setup

- [pnpm-not-npm](project/pnpm-not-npm.md) — This project (cortex-agent) uses pnpm, not npm. Trigger: any time the agent would suggest `npm install` / `npm run` / `npm test` commands.

## reference (1/50)
- [pilot projects entry](reference/pilot-projects-pointer.md) — pilot, validation, evidence
