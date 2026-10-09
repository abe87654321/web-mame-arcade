#!/usr/bin/env bash
# Apply or revert the Web MAME Arcade netplay patch against the pristine mame/
# submodule. The tracked tree is left exactly as it was before apply.
# Usage: core/patches/apply.sh {apply|revert|status|hash} | --help
set -euo pipefail

export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MAME_DIR="$REPO_ROOT/mame"
NETPLAY_DIR="$REPO_ROOT/core/patches/netplay"

# Ordered series; revert applies them in reverse.
PATCHES=(
  0001-machine.patch
  0002-ioport.patch
  0003-save.patch
  0004-build.patch
)

# src-in-netplay-dir:destination-relative-to-mame
NEW_FILES=(
  "netplay.h:src/emu/netplay.h"
  "netplay.cpp:src/emu/netplay.cpp"
  "netplay_post.js:scripts/resources/emscripten/netplay_post.js"
)

usage() {
  cat <<EOF
Usage: core/patches/apply.sh {apply|revert|status|hash}

  apply   copy the netplay sources into mame/ and git-apply the patch series
  revert  reverse-apply the series and remove the copied sources
  status  print whether the patch is currently applied
  hash    print the sha256 of the patch series (recorded in manifest.json)

The mame/ tracked tree must be clean before apply and is restored by revert.
EOF
}

require_mame() {
  if [[ ! -e "$MAME_DIR/makefile" ]]; then
    echo "error: mame/ submodule not initialised (run: git submodule update --init --depth 1)" >&2
    exit 3
  fi
}

assert_clean() {
  if ! git -C "$MAME_DIR" diff --quiet || ! git -C "$MAME_DIR" diff --cached --quiet; then
    echo "error: mame/ has uncommitted changes to tracked files; refusing to patch" >&2
    echo "       run: git -C mame checkout -- . && git -C mame reset" >&2
    exit 5
  fi
}

# True (exit 0) when every patch and copied source is present and reversable.
is_applied() {
  for spec in "${NEW_FILES[@]}"; do
    [[ -f "$MAME_DIR/${spec##*:}" ]] || return 1
  done
  for p in "${PATCHES[@]}"; do
    git -C "$MAME_DIR" apply --reverse --check "$NETPLAY_DIR/$p" >/dev/null 2>&1 || return 1
  done
  return 0
}

do_apply() {
  require_mame
  if is_applied; then
    echo "netplay patches already applied"
    return 0
  fi
  assert_clean
  for spec in "${NEW_FILES[@]}"; do
    src="${spec%%:*}"; dest="${spec##*:}"
    mkdir -p "$MAME_DIR/$(dirname "$dest")"
    cp "$NETPLAY_DIR/$src" "$MAME_DIR/$dest"
  done
  for p in "${PATCHES[@]}"; do
    git -C "$MAME_DIR" apply "$NETPLAY_DIR/$p"
    echo "applied $p"
  done
  echo "netplay patches applied"
}

do_revert() {
  require_mame
  if ! is_applied; then
    echo "netplay patches not applied"
    return 0
  fi
  for ((i = ${#PATCHES[@]} - 1; i >= 0; i--)); do
    git -C "$MAME_DIR" apply --reverse "$NETPLAY_DIR/${PATCHES[$i]}"
    echo "reverted ${PATCHES[$i]}"
  done
  for spec in "${NEW_FILES[@]}"; do
    rm -f "$MAME_DIR/${spec##*:}"
  done
  # Only tracked files matter here; untracked build outputs (scripts/*.a) are
  # expected and ignored.
  if ! git -C "$MAME_DIR" diff --quiet || ! git -C "$MAME_DIR" diff --cached --quiet; then
    echo "error: mame/ tracked tree is not clean after revert" >&2
    git -C "$MAME_DIR" diff --stat >&2
    exit 6
  fi
  echo "netplay patches reverted"
}

do_status() {
  require_mame
  if is_applied; then
    echo "netplay patches: applied"
  else
    echo "netplay patches: not applied"
  fi
}

do_hash() {
  {
    for p in "${PATCHES[@]}"; do cat "$NETPLAY_DIR/$p"; done
    cat "$NETPLAY_DIR/netplay.h" "$NETPLAY_DIR/netplay.cpp" "$NETPLAY_DIR/netplay_post.js"
  } | sha256sum | cut -d' ' -f1
}

case "${1:-}" in
  apply)  do_apply ;;
  revert) do_revert ;;
  status) do_status ;;
  hash)   do_hash ;;
  --help|-h) usage ;;
  "") usage >&2; exit 2 ;;
  *) echo "unknown subcommand: $1" >&2; usage >&2; exit 2 ;;
esac
