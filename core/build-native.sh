#!/usr/bin/env bash
# Build one free MAME driver natively and print the binary sha256.
# Usage: core/build-native.sh <driver> [--dry-run] | --list-drivers | --help
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAME_DIR="$REPO_ROOT/mame"

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
  echo "make -C $MAME_DIR SUBTARGET=$DRIVER SOURCES=$SOURCES -j$JOBS"
  exit 0
fi

if [[ ! -e "$MAME_DIR/makefile" ]]; then
  echo "error: mame/ submodule not initialised (run: git submodule update --init --depth 1)" >&2
  exit 3
fi
for tool in make gcc g++ python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: missing build tool: $tool" >&2; exit 3; }
done

make -C "$MAME_DIR" SUBTARGET="$DRIVER" SOURCES="$SOURCES" -j"$JOBS"

BIN=""
for cand in "$MAME_DIR/$DRIVER" "$MAME_DIR/$DRIVER.exe" "$MAME_DIR/mame$DRIVER"; do
  [[ -x "$cand" ]] && { BIN="$cand"; break; }
done
if [[ -z "$BIN" ]]; then
  echo "error: binary not found; looked for $DRIVER, $DRIVER.exe, mame$DRIVER in $MAME_DIR" >&2
  exit 4
fi

MAME_SHA="$(git -C "$MAME_DIR" rev-parse HEAD)"
HASH="$(sha256sum "$BIN" | cut -d' ' -f1)"
echo "driver:      $DRIVER"
echo "mame commit: $MAME_SHA"
echo "binary:      $BIN"
echo "sha256:      $HASH"
echo "$HASH  $BIN"
