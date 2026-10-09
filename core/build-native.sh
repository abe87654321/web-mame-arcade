#!/usr/bin/env bash
# Build one free MAME driver natively and print the binary sha256.
# Usage: core/build-native.sh <driver> [--dry-run] | --list-drivers | --help
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAME_DIR="$REPO_ROOT/mame"
APPLY="$REPO_ROOT/core/patches/apply.sh"

# MAME commit every native build must come from. Single source of truth:
# core/versions.json (mirrored in docs/02-emulation-core.md). Read lazily, after
# argument parsing, so --help/--list-drivers do not require node.
VERSIONS_FILE="$REPO_ROOT/core/versions.json"
read_pinned_mame_commit() {
  if ! command -v node >/dev/null 2>&1; then
    echo "error: node is required to read pinned versions from $VERSIONS_FILE" >&2
    exit 3
  fi
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).mameCommit)' "$VERSIONS_FILE"
}

# Shared driver -> comma-separated SOURCES map (same source list as the WASM build).
source "$REPO_ROOT/core/drivers.sh"

usage() {
  cat <<EOF
Usage: core/build-native.sh <driver> [--dry-run]
       core/build-native.sh --list-drivers
       core/build-native.sh --help

Builds a single driver (make SUBTARGET=<driver> SOURCES=...) and prints
"sha256  <path>" plus the pinned MAME commit. --dry-run only prints the make
command. Requires an initialised mame/ and the MAME Ubuntu build deps:
build-essential python3 libsdl2-dev libsdl2-ttf-dev libfontconfig-dev
libpulse-dev qt6-base-dev qt6-base-dev-tools qmake6.

Known drivers: ${!DRIVER_SOURCES[*]}
EOF
}

DRY_RUN=0
DRIVER=""
for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --list-drivers) printf '%s\n' "${!DRIVER_SOURCES[@]}"; exit 0 ;;
    --help|-h)      usage; exit 0 ;;
    -*)             echo "unknown option: $arg" >&2; usage >&2; exit 2 ;;
    *)              DRIVER="$arg" ;;
  esac
done

if [[ -z "$DRIVER" ]]; then usage >&2; exit 2; fi
if [[ -z "${DRIVER_SOURCES[$DRIVER]:-}" ]]; then
  echo "unknown driver: $DRIVER" >&2; usage >&2; exit 2
fi

SOURCES="${DRIVER_SOURCES[$DRIVER]}"
if command -v nproc >/dev/null 2>&1; then JOBS="$(nproc)"; else JOBS=4; fi

PINNED_MAME_COMMIT="$(read_pinned_mame_commit)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "bash $APPLY apply"
  echo "make -C $MAME_DIR SUBTARGET=$DRIVER SOURCES=$SOURCES IGNORE_GIT=1 NEW_GIT_VERSION=$PINNED_MAME_COMMIT -j$JOBS"
  exit 0
fi

if [[ ! -e "$MAME_DIR/makefile" ]]; then
  echo "error: mame/ submodule not initialised (run: git submodule update --init --depth 1)" >&2
  exit 3
fi
for tool in make gcc g++ python3 strip; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: missing build tool: $tool" >&2; exit 3; }
done

MAME_SHA="$(git -C "$MAME_DIR" rev-parse HEAD)"
if [[ "$MAME_SHA" != "$PINNED_MAME_COMMIT" ]]; then
  echo "error: mame/ is at $MAME_SHA but the pinned commit is $PINNED_MAME_COMMIT" >&2
  echo "       run: git -C mame checkout $PINNED_MAME_COMMIT" >&2
  exit 5
fi

# Remove any previous binary so make relinks from cached objects. `strip` is not
# idempotent on an already-stripped binary, so it must always run on a fresh link.
rm -f "$MAME_DIR/$DRIVER" "$MAME_DIR/$DRIVER.exe" "$MAME_DIR/mame$DRIVER"

# The verifier replays through the same patched source as the WASM core, so
# apply the netplay patch for the build and always revert it afterwards.
bash "$APPLY" apply
trap 'bash "$APPLY" revert' EXIT

# SYMBOLS=0/STRIP_SYMBOLS=1 are not used: MAME only re-runs genie when its makefile/scripts
# change, so changed sym/stop params would be ignored on an existing build tree. Instead we
# strip after linking (below). IGNORE_GIT silences a failing `git describe` in the shallow
# submodule; NEW_GIT_VERSION pins the embedded revision to the exact commit.
make -C "$MAME_DIR" \
  SUBTARGET="$DRIVER" \
  SOURCES="$SOURCES" \
  IGNORE_GIT=1 \
  NEW_GIT_VERSION="$MAME_SHA" \
  -j"$JOBS"

BIN=""
for cand in "$MAME_DIR/$DRIVER" "$MAME_DIR/$DRIVER.exe" "$MAME_DIR/mame$DRIVER"; do
  [[ -x "$cand" ]] && { BIN="$cand"; break; }
done
if [[ -z "$BIN" ]]; then
  echo "error: binary not found; looked for $DRIVER, $DRIVER.exe, mame$DRIVER in $MAME_DIR" >&2
  exit 4
fi

# Strip debug info (which embeds the absolute build path) and the link-time build-id
# (also hashed over that path), so a fixed commit + toolchain yields the same sha256
# regardless of the checkout directory.
strip -R .note.gnu.build-id "$BIN"

HASH="$(sha256sum "$BIN" | cut -d' ' -f1)"
echo "driver:      $DRIVER"
echo "mame commit: $MAME_SHA"
echo "toolchain:   $(uname -m), gcc $(gcc -dumpfullversion), binutils $(ld --version | head -n1 | awk '{print $NF}')"
echo "binary:      $BIN"
echo "sha256:      $HASH"
echo "$HASH  $BIN"
