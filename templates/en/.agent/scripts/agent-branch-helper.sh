#!/usr/bin/env bash

set -euo pipefail

readonly ALLOWED_SUBDIRS="plans missions handoffs incidents"

die() {
  local message="$1"
  local code="${2:-1}"
  printf '[agent-branch-helper] ERROR: %s\n' "$message" >&2
  exit "$code"
}

usage() {
  cat <<'EOF'
Usage: agent-branch-helper.sh <command> [subdirectory]

Commands:
  branch-name             Print the current branch name.
  branch-slug             Print its collision-safe namespace slug.
  namespace               Print the absolute namespace path.
  ensure                  Create the four supported namespace directories.
  ensure-current <subdir> Create and print one supported directory.
  relpath <subdir>        Print one supported path relative to the repository.
  status                  Print the branch, slug, and namespace without writing.

Supported subdirectories: plans, missions, handoffs, incidents
EOF
}

require_no_args() {
  [[ "$#" -eq 0 ]] || die "this command accepts no arguments" 2
}

validate_subdir() {
  local subdir="${1:-}"
  [[ "$#" -eq 1 ]] || die "expected exactly one subdirectory" 2

  case "$subdir" in
    plans|missions|handoffs|incidents) printf '%s\n' "$subdir" ;;
    *) die "subdirectory must be one of: $ALLOWED_SUBDIRS (got: '$subdir')" 2 ;;
  esac
}

resolve_agent_root() {
  local script_dir candidate
  script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
  candidate="${AGENT_ROOT:-$script_dir/..}"
  [[ -d "$candidate" ]] || die "AGENT_ROOT is not a directory: $candidate" 1
  AGENT_ROOT_RESOLVED=$(CDPATH= cd -- "$candidate" && pwd -P)
}

detect_repository() {
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || \
    die "not inside a Git worktree" 1
  REPO_ROOT=$(CDPATH= cd -- "$REPO_ROOT" && pwd -P)

  BRANCH_NAME=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || \
    die "HEAD is detached; switch to a branch before using a branch namespace" 3

  # Escape '%' first so slash encoding cannot collide with a literal '%2F'.
  BRANCH_SLUG="${BRANCH_NAME//%/%25}"
  BRANCH_SLUG="${BRANCH_SLUG//\//%2F}"
  [[ -n "$BRANCH_SLUG" ]] || die "could not derive a branch slug" 1
  NAMESPACE_PATH="$AGENT_ROOT_RESOLVED/branches/$BRANCH_SLUG"
}

namespace_relpath() {
  local logical_agent resolved_logical relative_agent
  logical_agent="$REPO_ROOT/.agent"

  if [[ -d "$logical_agent" ]]; then
    resolved_logical=$(CDPATH= cd -- "$logical_agent" && pwd -P)
    if [[ "$resolved_logical" == "$AGENT_ROOT_RESOLVED" ]]; then
      printf '.agent/branches/%s/%s\n' "$BRANCH_SLUG" "$1"
      return
    fi
  fi

  case "$AGENT_ROOT_RESOLVED" in
    "$REPO_ROOT"/*)
      relative_agent="${AGENT_ROOT_RESOLVED#"$REPO_ROOT"/}"
      printf '%s/branches/%s/%s\n' "$relative_agent" "$BRANCH_SLUG" "$1"
      ;;
    *)
      die "AGENT_ROOT is outside this worktree and is not reachable through .agent; use namespace instead" 1
      ;;
  esac
}

main() {
  local command="${1:-}"
  if [[ "$#" -gt 0 ]]; then
    shift
  fi

  case "$command" in
    -h|--help|help|'') usage; exit 0 ;;
  esac

  resolve_agent_root
  detect_repository

  case "$command" in
    branch-name)
      require_no_args "$@"
      printf '%s\n' "$BRANCH_NAME"
      ;;
    branch-slug)
      require_no_args "$@"
      printf '%s\n' "$BRANCH_SLUG"
      ;;
    namespace)
      require_no_args "$@"
      printf '%s\n' "$NAMESPACE_PATH"
      ;;
    ensure)
      require_no_args "$@"
      mkdir -p -- "$NAMESPACE_PATH/plans" "$NAMESPACE_PATH/missions" \
        "$NAMESPACE_PATH/handoffs" "$NAMESPACE_PATH/incidents"
      printf '%s\n' "$NAMESPACE_PATH"
      ;;
    ensure-current)
      local subdir
      subdir=$(validate_subdir "$@")
      mkdir -p -- "$NAMESPACE_PATH/$subdir"
      printf '%s\n' "$NAMESPACE_PATH/$subdir"
      ;;
    relpath)
      local subdir
      subdir=$(validate_subdir "$@")
      namespace_relpath "$subdir"
      ;;
    status)
      require_no_args "$@"
      printf 'branch=%s\nslug=%s\nnamespace=%s\n' \
        "$BRANCH_NAME" "$BRANCH_SLUG" "$NAMESPACE_PATH"
      ;;
    *) die "unknown command: '$command' (try --help)" 2 ;;
  esac
}

main "$@"
