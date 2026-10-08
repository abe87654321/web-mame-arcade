#!/usr/bin/env bash
# Build one free MAME driver natively and print the binary sha256.
# Usage: core/build-native.sh <driver> [--dry-run] | --list-drivers | --help
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAME_DIR="$REPO_ROOT/mame"

# MAME commit every native build must come from (see docs/02-emulation-core.md).
PINNED_MAME_COMMIT="b67e5bcb0b895c0e451e342068b6651af1307d0d"

# driver -> comma-separated SOURCES. Free ROMs: https://www.mamedev.org/roms/
declare -A DRIVER_SOURCES=(
  [gridlee]="src/mame/bally/gridlee.cpp,src/mame/bally/gridlee_a.cpp,src/mame/bally/gridlee_v.cpp"
)

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

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "make -C $MAME_DIR SUBTARGET=$DRIVER SOURCES=$SOURCES SYMBOLS=0 STRIP_SYMBOLS=1 NEW_GIT_VERSION=$PINNED_MAME_COMMIT -j$JOBS"
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

# SYMBOLS=0/STRIP_SYMBOLS=1 remove debug info (which embeds the absolute build path);
# NEW_GIT_VERSION fixes the embedded BARE_VCS_REVISION instead of git-describe output,
# so the same commit + toolchain yields the same binary sha256 across checkout paths.
make -C "$MAME_DIR" \
  SUBTARGET="$DRIVER" \
  SOURCES="$SOURCES" \
  SYMBOLS=0 STRIP_SYMBOLS=1 \
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

HASH="$(sha256sum "$BIN" | cut -d' ' -f1)"
echo "driver:      $DRIVER"
echo "mame commit: $MAME_SHA"
echo "toolchain:   $(uname -m), gcc $(gcc -dumpversion)"
echo "binary:      $BIN"
echo "sha256:      $HASH"
echo "$HASH  $BIN"
