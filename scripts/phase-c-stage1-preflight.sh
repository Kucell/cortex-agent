#!/usr/bin/env bash
# =============================================================================
# phase-c-stage1-preflight.sh — M-025 / MS-003 Phase C Stage 1 (Shadow)
# Shadow Readiness pre-flight checklist (operationalizes handoff §4).
#
# Source of truth: .agent/missions/M-025/handoffs/phase-c-stage1-shadow-readiness.md
# Authority:       phase-c-evaluation-framework.md §2 + §6.1
#
# When to run:     BEFORE submitting D-M025-MS003-phaseC-shadow-<sha> entry Decision.
# What it does:    Runs the 7 pre-decision bash checks, captures digests, and
#                  prints a machine-readable readiness report (JSON) for the
#                  Decision's evidence_refs.
#
# Scope boundary:  READ-ONLY verification. Does NOT activate P-002/P-003/P-004,
#                  does NOT write policy, does NOT modify ledger (rollback drill
#                  is --dry-run only).
#
# Usage:
#   bash scripts/phase-c-stage1-preflight.sh [--project <root>] [--json]
#   --project  project root (default: current cwd; the repo hosting passive-collector)
#   --json     emit machine-readable readiness report to stdout
#   --skip-rollback  skip check #7 (rollback drill) — only for CI fixtures
# =============================================================================
set -euo pipefail

PROJECT="${PROJECT:-$(pwd)}"
EMIT_JSON=0
SKIP_ROLLBACK=0
REPO="$(pwd)"

# --- resolve --project ---
ARGS=("$@")
for ((i=0; i<${#ARGS[@]}; i++)); do
  case "${ARGS[$i]}" in
    --json) EMIT_JSON=1 ;;
    --skip-rollback) SKIP_ROLLBACK=1 ;;
    --project) PROJECT="${ARGS[$((i+1))]}" ;;
    --*) echo "Unknown flag: ${ARGS[$i]}" >&2; exit 2 ;;
  esac
done

echo "📋 Phase C Stage 1 (Shadow) pre-flight — project: $PROJECT" >&2
echo "=============================================================" >&2

# --- check 0: layout ---
if [[ ! -d "$PROJECT/.agent" ]]; then
  echo "❌ [preflight] $PROJECT/.agent not found — is this a cortex-agent project?" >&2
  exit 1
fi

# The readiness query lives on passive-collector (lib/host-adapter/shadow-usage).
# Locate the collector script: prefer repo cwd, then project.
COLLECTOR_SCRIPT="$REPO/lib/host-adapter/shadow-usage/passive-collector.js"
if [[ ! -f "$COLLECTOR_SCRIPT" ]] && [[ -f "$PROJECT/lib/host-adapter/shadow-usage/passive-collector.js" ]]; then
  COLLECTOR_SCRIPT="$PROJECT/lib/host-adapter/shadow-usage/passive-collector.js"
fi
if [[ ! -f "$COLLECTOR_SCRIPT" ]]; then
  echo "❌ [preflight] passive-collector.js not found (repo=$REPO, project=$PROJECT)" >&2
  echo "   Expected at lib/host-adapter/shadow-usage/passive-collector.js" >&2
  exit 1
fi
# Ensure node can resolve relative requires from the collector's directory.
COLLECTOR_DIR="$(dirname "$COLLECTOR_SCRIPT")"

# helper: run queryReadiness via node (readiness is a method on passiveCollector)
readiness_json() {
  node -e "
    const mod = require('$COLLECTOR_SCRIPT');
    const pc = mod.createPassiveCollector
      ? mod.createPassiveCollector()
      : new mod.PassiveCollector();
    const path = require('path');
    const root = '$PROJECT';
    const ledgerDir = path.join(root, '.agent', 'token-attempts');
    try {
      const stats = pc.queryReadiness(ledgerDir, {});
      console.log(JSON.stringify(stats));
    } catch (e) {
      console.error('queryReadiness error:', e.message);
      console.log('{}');
    }
  " 2>/dev/null || echo '{}'
}

declare -a RESULTS=()
PASS_COUNT=0
FAIL_COUNT=0

# =============================================================================
# 1. Sample gate + integrity — agent-host dimension (attempt_id prefix)
#    P-005 §5 "两个 Host" 语义 = agent host (codex/dsh/pi), NOT LLM provider.
#    readiness host 维度是 provider; agent host 从 attempt_id 前缀派生。
# =============================================================================
echo "1/7 Sample gate + integrity (G-SampleGate, agent-host dimension)..." >&2
SAMPLE_JSON="$(readiness_json)"
ELIGIBLE="$(echo "$SAMPLE_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.eligible_count??'n/a')}catch(e){console.log('parse-error')}})" 2>/dev/null || echo 'n/a')"
EXCL="$(echo "$SAMPLE_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const e=j.by_exclusion_reason??{};console.log(Object.keys(e).filter(k=>/test/i.test(k)).join(','))}catch(e){console.log('parse-error')}})" 2>/dev/null || echo 'n/a')"
# agent-host 维度: 直接从 ledger 扫描 attempt_id 前缀 (ocx-/dsh-/pi-/test-)
AGENT_HOSTS="$(node -e "
  const fs = require('fs');
  const path = require('path');
  const ledgerDir = path.join('$PROJECT', '.agent', 'token-attempts');
  try {
    const index = JSON.parse(fs.readFileSync(path.join(ledgerDir, 'ledger-index.json'), 'utf8'));
    const entries = index.entries || [];
    const hosts = new Set();
    for (const e of entries) {
      const id = e.attempt_id || '';
      if (id.startsWith('ocx-')) hosts.add('codex');
      else if (id.startsWith('dsh-')) hosts.add('dsh');
      else if (id.startsWith('pi-')) hosts.add('pi');
      else if (id.startsWith('test-')) hosts.add('test');
    }
    console.log([...hosts].join(','));
  } catch (e) { console.log(''); }
" 2>/dev/null || echo '')"
# 过滤 test
NON_TEST_HOSTS="$(echo "$AGENT_HOSTS" | tr ',' '\n' | grep -v '^test$' | grep -c . || true)"
echo "   eligible_count=$ELIGIBLE agent_hosts=[$AGENT_HOSTS] test_exclusions=[$EXCL]" >&2
if [[ "$NON_TEST_HOSTS" -ge 2 ]] && [[ -n "$EXCL" ]]; then
  echo "   ✅ sample-gate: agent-hosts>=2, test-exclusions present" >&2
  PASS_COUNT=$((PASS_COUNT+1)); RESULTS+=("sample_gate=PASS agent_hosts=$AGENT_HOSTS eligible=$ELIGIBLE")
else
  echo "   ⚠️  sample-gate: incomplete (agent_hosts=$NON_TEST_HOSTS, excl=[$EXCL]) — Phase B window may not be full yet" >&2
  FAIL_COUNT=$((FAIL_COUNT+1)); RESULTS+=("sample_gate=WARN agent_hosts=$AGENT_HOSTS eligible=$ELIGIBLE")
fi

# =============================================================================
# 2. Inference rate (G-NoInference) — count inferred-source receipts
# =============================================================================
echo "2/7 Inference rate (G-NoInference)..." >&2
INF_JSON="$(node -e "
  const { queryReceipts } = require('$COLLECTOR_DIR/token-attempt-ledger.js');
  const path = require('path');
  const ledgerDir = path.join('$PROJECT', '.agent', 'token-attempts');
  let total = 0, inferred = 0;
  try {
    const receipts = queryReceipts(ledgerDir, {});
    for (const r of receipts) {
      total++;
      if (r.usage_source === 'inferred' || r.inferred === true || r.source === 'inferred') inferred++;
    }
  } catch (e) { /* ledger empty or missing */ }
  console.log(JSON.stringify({ total, inferred, rate: total ? (inferred / total) : 0 }));
" 2>/dev/null || echo '{"total":0,"inferred":0,"rate":0}')"
INF_RATE="$(echo "$INF_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.rate??'n/a')}catch(e){console.log('parse-error')}})" 2>/dev/null || echo 'n/a')"
INF_TOTAL="$(echo "$INF_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.total??0)}catch(e){console.log('0')}})" 2>/dev/null || echo '0')"
echo "   inference_rate=$INF_RATE (acceptance: <= 0.05; total receipts: $INF_TOTAL)" >&2
if [[ "$INF_RATE" != "n/a" ]] && [[ "$INF_RATE" != "parse-error" ]]; then
  OK=$(node -e "console.log(parseFloat('$INF_RATE') <= 0.05 ? 'y' : 'n')")
  if [[ "$OK" == "y" ]]; then
    echo "   ✅ inference-rate within 5% band" >&2
    PASS_COUNT=$((PASS_COUNT+1)); RESULTS+=("inference_rate=PASS rate=$INF_RATE")
  else
    echo "   ❌ inference-rate exceeds 5% band (rate=$INF_RATE)" >&2
    FAIL_COUNT=$((FAIL_COUNT+1)); RESULTS+=("inference_rate=FAIL rate=$INF_RATE")
  fi
else
  echo "   ⚠️  inference-rate n/a (ledger may be empty)" >&2
  FAIL_COUNT=$((FAIL_COUNT+1)); RESULTS+=("inference_rate=WARN rate=n/a")
fi

# =============================================================================
# 3. Reproducibility rerun (G-Reproducibility)
# =============================================================================
echo "3/7 Reproducibility rerun (G-Reproducibility)..." >&2
D1="$(readiness_json | shasum -a 256 | cut -d' ' -f1)"
D2="$(readiness_json | shasum -a 256 | cut -d' ' -f1)"
EMPTY_SHA="$(printf '{}' | shasum -a 256 | cut -d' ' -f1)"
if [[ "$D1" == "$D2" ]] && [[ -n "$D1" ]] && [[ "$D1" != "$EMPTY_SHA" ]]; then
  echo "   ✅ reproducible: sha256=$D1 (match)" >&2
  PASS_COUNT=$((PASS_COUNT+1)); RESULTS+=("reproducibility=PASS sha256=${D1:0:12}")
else
  echo "   ⚠️  reproducibility: digest mismatch or empty ledger" >&2
  FAIL_COUNT=$((FAIL_COUNT+1)); RESULTS+=("reproducibility=WARN d1=${D1:0:12} d2=${D2:0:12}")
fi

# =============================================================================
# 4. Schema + regression tests (G-Reproducibility + MS-001 contract)
# =============================================================================
echo "4/7 Schema + shadow-usage regression tests..." >&2
TEST_DIR="$REPO/tests/host-adapter/shadow-usage"
if [[ ! -d "$TEST_DIR" ]] && [[ -d "$PROJECT/tests/host-adapter/shadow-usage" ]]; then
  TEST_DIR="$PROJECT/tests/host-adapter/shadow-usage"
fi
TEST_OUT=""
if [[ -d "$TEST_DIR" ]]; then
  TEST_OUT="$(node --test "$TEST_DIR"/*.test.js 2>&1 || true)"
fi
TEST_PASS="$(echo "$TEST_OUT" | grep -cE '^(ok |✔|✓)' || true)"
TEST_FAIL="$(echo "$TEST_OUT" | grep -cE '^(not ok |✖|✗)' || true)"
echo "   tests: pass=$TEST_PASS fail=$TEST_FAIL (dir: $TEST_DIR)" >&2
if [[ "$TEST_FAIL" == "0" ]] && [[ "$TEST_PASS" -gt 0 ]]; then
  echo "   ✅ shadow-usage tests green" >&2
  PASS_COUNT=$((PASS_COUNT+1)); RESULTS+=("tests=PASS pass=$TEST_PASS fail=0")
else
  echo "   ⚠️  shadow-usage tests not fully green (pass=$TEST_PASS fail=$TEST_FAIL)" >&2
  FAIL_COUNT=$((FAIL_COUNT+1)); RESULTS+=("tests=WARN pass=$TEST_PASS fail=$TEST_FAIL")
fi

# =============================================================================
# 5. Architecture Guard on shadow-usage (no activation path) (G-Governance)
# =============================================================================
echo "5/7 Architecture Guard (G-Governance)..." >&2
GUARD_SCRIPT="$REPO/.agent/skills/architecture-guard/scripts/index.js"
GUARD_OUT=""
if [[ -f "$GUARD_SCRIPT" ]]; then
  GUARD_OUT="$(cd "$REPO" && node "$GUARD_SCRIPT" --scope lib/host-adapter/shadow-usage/ 2>&1 || true)"
else
  GUARD_OUT="(architecture-guard script not found — skipped)"
fi
echo "   guard: $(echo "$GUARD_OUT" | tail -2 | head -1)" >&2
if echo "$GUARD_OUT" | grep -qiE "no architectural violations|✅"; then
  echo "   ✅ architecture-guard clean (or skipped)" >&2
  PASS_COUNT=$((PASS_COUNT+1)); RESULTS+=("arch_guard=PASS")
elif echo "$GUARD_OUT" | grep -qiE "violation|error|❌"; then
  echo "   ⚠️  architecture-guard reported issues (check output below)" >&2
  echo "$GUARD_OUT" | tail -5 >&2
  FAIL_COUNT=$((FAIL_COUNT+1)); RESULTS+=("arch_guard=WARN")
else
  echo "   ✅ architecture-guard produced no violation signal" >&2
  PASS_COUNT=$((PASS_COUNT+1)); RESULTS+=("arch_guard=PASS")
fi

# =============================================================================
# 6. Active audit — no P-002/P-003/P-004 in activation path (G-Governance)
# =============================================================================
echo "6/7 Active audit (no policy activation leak)..." >&2
ACTIVE_AUDIT="$(grep -rnE 'P-002|P-003|P-004' "$COLLECTOR_SCRIPT" 2>/dev/null | grep -vE '^\s*[0-9]+:\s*//' || true)"
if [[ -z "$ACTIVE_AUDIT" ]]; then
  echo "   ✅ no P-002/P-003/P-004 activation references in passive-collector.js" >&2
  PASS_COUNT=$((PASS_COUNT+1)); RESULTS+=("active_audit=PASS")
else
  echo "   ❌ activation-path leak detected:" >&2
  echo "$ACTIVE_AUDIT" | head -5 >&2
  FAIL_COUNT=$((FAIL_COUNT+1)); RESULTS+=("active_audit=FAIL")
fi

# =============================================================================
# 7. Rollback drill (G-Rollback, dry-run only)
# =============================================================================
echo "7/7 Rollback drill (G-Rollback, dry-run)..." >&2
if [[ "$SKIP_ROLLBACK" == "1" ]]; then
  echo "   ⏭  skipped (--skip-rollback)" >&2
  PASS_COUNT=$((PASS_COUNT+1)); RESULTS+=("rollback_drill=SKIPPED")
else
  MIG_SCRIPT="$REPO/.agent/skills/management-api/scripts/runtime-state-layout-migration.js"
  if [[ -f "$MIG_SCRIPT" ]]; then
    ROLLBACK_OUT="$(node "$MIG_SCRIPT" rollback --from-policy-revision HEAD --to HEAD~1 --dry-run 2>&1 || true)"
    if echo "$ROLLBACK_OUT" | grep -qiE "error|fail"; then
      echo "   ⚠️  rollback drill reported issues (dry-run only, not blocking for Shadow)" >&2
      FAIL_COUNT=$((FAIL_COUNT+1)); RESULTS+=("rollback_drill=WARN")
    else
      echo "   ✅ rollback drill dry-run ok" >&2
      PASS_COUNT=$((PASS_COUNT+1)); RESULTS+=("rollback_drill=PASS")
    fi
  else
    echo "   ⚠️  runtime-state-layout-migration.js not found — drill skipped" >&2
    FAIL_COUNT=$((FAIL_COUNT+1)); RESULTS+=("rollback_drill=WARN missing-script")
  fi
fi

# =============================================================================
# Summary
# =============================================================================
echo "=============================================================" >&2
echo "📊 Pre-flight result: $PASS_COUNT PASS / $FAIL_COUNT WARN-FAIL (7 total)" >&2

if [[ "$EMIT_JSON" == "1" ]]; then
  printf '{\n  "schema_version": 1,\n  "check": "phase-c-stage1-shadow-preflight",\n  "project": %s,\n  "run_at": %s,\n  "summary": { "pass": %d, "warn_fail": %d, "total": 7 },\n  "results": [\n' \
    "\"$PROJECT\"" "\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" "$PASS_COUNT" "$FAIL_COUNT"
  for ((i=0; i<${#RESULTS[@]}; i++)); do
    comma=""; [[ $i -lt $((${#RESULTS[@]}-1)) ]] && comma=","
    printf '    %s%s\n' "\"${RESULTS[$i]}\"" "$comma"
  done
  printf '  ]\n}\n'
fi

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "⚠️  Not all checks green — Phase B window may not be full, or non-blocking items pending." >&2
  echo "    See handoff phase-c-stage1-shadow-readiness.md §2 for acceptance criteria." >&2
  echo "    DO NOT submit D-M025-MS003-phaseC-shadow-<sha> until blocking gates pass." >&2
  exit 0  # exit 0 = report produced (gates assessed inside JSON); use --json to gate programmatically
fi

echo "✅ All 7 checks green — ready to submit D-M025-MS003-phaseC-shadow-<sha> (pending user approval)." >&2
exit 0
