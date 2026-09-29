# M-040 Runtime / Project Integration Runbook

> **Status**: M-040 MS-011 operational baseline  
> **Date**: 2026-09-29

## 1. Repository model

Cortex Agent development uses two repositories:

```text
Kucell/cortex-agent
  product/framework source

Kucell/cortex-agent-agent
  independent development-governance repository
  mounted/materialized as cortex-agent/.agent when developing or running
  tests that require project governance state
```

Do not add `cortex-agent-agent` to `pnpm-workspace.yaml`.

Do not include the development `.agent` repository in the root npm package.

## 2. Product-only validation

Product/package architecture that does not require the project's development-governance state can run directly in `cortex-agent`:

```bash
pnpm install --frozen-lockfile
pnpm guard:m040
pnpm test:m040
npm pack --dry-run
```

This validates the monorepo/package boundaries, Protocol/SDK, RuntimePort, topology/routing, Control Service, CortexEvent, Extension/Permission, Project SDK, Paseo adapter/governance surface, and governed E2E fixtures.

## 3. Full project-development regression

Some existing Cortex tests intentionally reference the project's own `.agent` state.

For those tests, use the two-repository environment:

```text
workspace/
├── governance/        # cortex-agent-agent checkout
└── cortex/            # cortex-agent checkout
    └── .agent/        # materialized governance content
```

CI currently materializes a copy of the governance repository into `cortex/.agent`.

Materialization is a test/development operation only; it is not a product packaging step.

## 4. Regression baseline

The M-040 merge base is:

```text
d9251d953a8b663b86b7712624baaac649924e46
```

In the same two-repository CI environment, that baseline has 14 known failing full-suite test files.

M-040 uses a baseline-diff gate:

```text
existing baseline failure -> recorded debt, not a new M-040 regression
baseline failure healed    -> improvement
new failure                -> blocks M-040
```

The baseline list is encoded in `scripts/m040/check-regression-baseline.js`.

This does not hide failures; the complete test log and diff report are retained as CI evidence.

## 5. Native runtime mode

Native adapters remain the minimum-dependency execution mode.

```text
Governance / Control
  -> RuntimePort
  -> legacy/native adapter bridge
  -> Codex / Claude / Pi / ...
```

Paseo is not required.

## 6. Paseo runtime mode

Paseo is an optional RuntimePort implementation.

Before use, install a compatible public `@getpaseo/client` in the integration environment. Core workspace peer auto-install remains disabled.

Supported public-SDK capabilities currently include create, send, status, wait, timeline and archive. Cancel is not advertised until Paseo exposes it through its public agent-handle API.

## 7. Runtime selection

Routing is two-stage:

```text
RuntimeRequirement
  -> RuntimeEndpoint hard filter
  -> explicit endpoint/profile binding
  -> existing host capability matcher
  -> selection
```

Selection is not authorization. A Control Service execution still requires a governed authorization result and `authorization_ref`.

## 8. External connected project

A connected project such as Axrail owns a root `cortex.project.json`.

Cortex validates the descriptor and may invoke explicitly governed Project Adapter operations. Descriptor validation never executes arbitrary shell content.

The current pilot validator permits simple `pnpm <script>` validation profile declarations and verifies that those scripts exist.

## 9. Axrail authority boundary

For the Axrail pilot:

```text
Cortex
  -> software-development governance and orchestration

Axrail
  -> engineering/domain execution authority
```

Cortex must not bypass Axrail's HarnessRuntime, ToolRuntime, Policy, Validation, Approval, TransactionRuntime, EventStore or Engineering Adapters.

## 10. CortexEvent handling

Runtime/project events are observation/evidence, not commands.

When timeline sequence gaps, regressions, or Paseo epoch resets occur, `reconciliation.required = true`; consumers must consult authoritative state rather than infer missing transitions.

## 11. Extension permissions

Extension manifests declare permissions. Policy evaluation may return `allow`, `deny`, or `approval_required`.

The evaluator does not claim sandbox enforcement. If an external runtime or third-party process can bypass Cortex, that limitation must remain visible.

## 12. CI ownership

```text
cortex-agent CI
  -> product/package/focused architecture validation

cortex-agent-agent CI
  -> project-development full regression with .agent materialized

Axrail pilot CI
  -> connected-project contract + Axrail-owned release validation
```

This separation mirrors repository authority and prevents CI from implicitly merging product and development-governance repositories.

## 13. Failure diagnosis

When a product validation fails:

1. check package/Protocol/SDK/guard regression;
2. do not assume `.agent` is available.

When a full-development regression fails:

1. verify the governance repository revision;
2. verify `.agent` materialization;
3. compare against the pinned merge-base failure set;
4. treat only new failures as M-040 regressions;
5. keep baseline failures visible as existing debt.

## 14. Release/merge readiness

M-040 is ready for merge review only when:

- product validation is green;
- Architecture Guard is green;
- focused M-040 tests are green;
- root package dry-run succeeds;
- Axrail connected-project pilot remains green;
- cross-repo full regression introduces no failures beyond the pinned baseline.
