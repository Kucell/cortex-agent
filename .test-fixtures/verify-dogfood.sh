#!/bin/bash
# Post local-publish-validate verification for proposal-share (v1.13.0-rc.4)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/.test-fixtures/dogfood-target"
echo '=== 1. tarball ==='
ls -la "$ROOT"/cortex-agent-1.13.0-rc.4.tgz 2>&1
echo && echo '=== 2. installed version ==='
cortex-agent --version 2>&1 | head -2
echo && echo '=== 3. templates synced into target .agent ==='
for f in workflows/proposal-share.md scripts/proposal-share.js rules/proposal-structure.md; do
  if [ -f "$TARGET/.agent/$f" ]; then echo "OK  .agent/$f"; else echo "MISSING  .agent/$f"; fi
done
echo && echo '=== 4. rule sharing section present ==='
grep -c "跨仓库 / 跨开发者共享" "$TARGET/.agent/rules/proposal-structure.md" 2>/dev/null || echo "NOT FOUND"
echo && echo '=== 5. CLI help in target ==='
cd "$TARGET" && cortex-agent proposal-share --help 2>&1 | head -6
echo && echo '=== 6. CLI export/verify round-trip in target ==='
cd "$TARGET"
mkdir -p .agent/plans/proposals/projects/demo-dogfood/proposals .agent/plans/proposals/projects/demo-dogfood/decisions
cat > .agent/plans/proposals/projects/demo-dogfood/index.md <<EOF
---
cross_project_peers:
  - /nowhere/peer-repo
---
# Demo Dogfood
> 关联仓库 /nowhere/peer-repo 是移动端范围真源。
EOF
echo "# P-001" > .agent/plans/proposals/projects/demo-dogfood/proposals/P-001-proposal.md
echo "# D-001" > .agent/plans/proposals/projects/demo-dogfood/decisions/D-001.md
mkdir -p .agent/missions/M-dog-001
echo "# M-dog-001 — 执行 projects/demo-dogfood 的 P-001" > .agent/missions/M-dog-001/mission-plan.md
rm -rf /tmp/dogfood-out && mkdir -p /tmp/dogfood-out
cortex-agent proposal-share export --slug demo-dogfood --root "$TARGET" --out /tmp/dogfood-out 2>&1 | head -30
echo "---"
PKG=$(ls /tmp/dogfood-out/*.tar.gz 2>/dev/null | head -1)
if [ -n "$PKG" ]; then cortex-agent proposal-share verify --package "$PKG" --root "$TARGET" 2>&1 | head -20; fi
echo && echo '=== DONE ==='
