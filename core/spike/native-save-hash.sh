#!/usr/bin/env bash
# T28 native save/load/hash spike.
#
# Boots one free driver headless, lets it run, then measures the machine-state
# size and the save()/load()/hash() cost a T40 rollback ring or a T45
# server-authoritative host would pay, and checks a save -> advance -> load
# round-trip restores the same RAM hash. See core/spike/save-hash.lua and
# docs/tasks/README.md (T28).
#
# Usage: core/spike/native-save-hash.sh [driver] [options]
#   --boot <n>      frames to boot before measuring (default 60)
#   --iters <n>     timed iterations per primitive (default 50)
#   --span <n>      frames between save and load check (default 30)
#   --rompath <dir> ROM directory (default <repo>/roms)
#   --binary <path> MAME binary (default <repo>/mame/<driver>)
#   --keep          keep the temporary working directory
#   --dry-run       print the command that would run, then exit
#   --help          show this help
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LUA="$REPO_ROOT/core/spike/save-hash.lua"

declare -A KNOWN_DRIVERS=( [gridlee]=1 )
DEFAULT_DRIVER=gridlee

BOOT=60
ITERS=50
SPAN=30
ROMPATH="$REPO_ROOT/roms"
BINARY=""
KEEP=0
DRY_RUN=0
DRIVER=""

usage() {
  cat <<EOF
Usage: core/spike/native-save-hash.sh [driver] [options]

Records the machine-state size and save/load/hash cost and prints "RESULT: PASS"
iff the save -> advance -> load round-trip restores the same RAM hash.

Options:
  --boot <n>       frames to boot before measuring (default $BOOT)
  --iters <n>      timed iterations per primitive (default $ITERS)
  --span <n>       frames between save and load check (default $SPAN)
  --rompath <dir>  ROM directory (default $ROMPATH)
  --binary <path>  MAME binary (default <repo>/mame/<driver>)
  --timeout <secs> wall-clock limit (default 120)
  --keep           keep the temporary working directory
  --dry-run        print the commands that would run, then exit
  --help           show this help

Known drivers: ${!KNOWN_DRIVERS[*]}

A free gridlee.zip ROM is available from https://www.mamedev.org/roms/ and must
be placed in the ROM directory (roms/ is gitignored).
EOF
}

TIMEOUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --boot)     BOOT="${2:?--boot needs a value}"; shift 2 ;;
    --iters)    ITERS="${2:?--iters needs a value}"; shift 2 ;;
    --span)     SPAN="${2:?--span needs a value}"; shift 2 ;;
    --rompath)  ROMPATH="${2:?--rompath needs a value}"; shift 2 ;;
    --binary)   BINARY="${2:?--binary needs a value}"; shift 2 ;;
    --timeout)  TIMEOUT="${2:?--timeout needs a value}"; shift 2 ;;
    --keep)     KEEP=1; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --help|-h)  usage; exit 0 ;;
    -*)         echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)          DRIVER="$1"; shift ;;
  esac
done

DRIVER="${DRIVER:-$DEFAULT_DRIVER}"
if [[ -z "${KNOWN_DRIVERS[$DRIVER]:-}" ]]; then
  echo "unknown driver: $DRIVER" >&2
  usage >&2
  exit 2
fi
for pair in "boot:$BOOT" "iters:$ITERS" "span:$SPAN"; do
  name="${pair%%:*}"; val="${pair#*:}"
  if [[ ! "$val" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: --$name must be a positive integer (got '$val')" >&2
    exit 2
  fi
done
BINARY="${BINARY:-$REPO_ROOT/mame/$DRIVER}"
TIMEOUT="${TIMEOUT:-120}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "driver:  $DRIVER"
  echo "binary:  $BINARY"
  echo "lua:     $LUA"
  echo "rompath: $ROMPATH"
  echo "options: --boot $BOOT --iters $ITERS --span $SPAN"
  echo "command:"
  echo "  WMA_SPIKE_BOOT=$BOOT WMA_SPIKE_ITERS=$ITERS WMA_SPIKE_SPAN=$SPAN \\"
  echo "    $BINARY $DRIVER -rompath $ROMPATH -video none -sound none -nothrottle \\"
  echo "    -skip_gameinfo -autoboot_script <tmp>/spike-run.lua"
  exit 0
fi

if [[ ! -x "$BINARY" ]]; then
  echo "error: MAME binary not found or not executable: $BINARY" >&2
  echo "       build it with: core/build-native.sh $DRIVER" >&2
  exit 3
fi
ROM_FILE="$ROMPATH/$DRIVER.zip"
if [[ ! -f "$ROM_FILE" ]]; then
  echo "error: ROM not found: $ROM_FILE" >&2
  echo "       download free ${DRIVER}.zip from https://www.mamedev.org/roms/ into $ROMPATH/" >&2
  exit 4
fi
if [[ ! -f "$LUA" ]]; then
  echo "error: Lua spike script not found: $LUA" >&2
  exit 3
fi
if ! command -v setsid >/dev/null 2>&1; then
  echo "error: setsid is required to run MAME in its own process group" >&2
  exit 3
fi

BIN_SHA="$(sha256sum "$BINARY" | cut -d' ' -f1)"
MAME_SHA="$(git -C "$REPO_ROOT/mame" rev-parse HEAD 2>/dev/null || echo unknown)"

echo "driver:      $DRIVER"
echo "binary:      $BINARY"
echo "binary sha:  $BIN_SHA"
echo "mame commit: $MAME_SHA"
echo "options:     --boot $BOOT --iters $ITERS --span $SPAN"
echo

TMP="$(mktemp -d)"
RUN="$TMP/run"
mkdir -p "$RUN/cfg" "$RUN/nvram" "$RUN/sta" "$RUN/snap" "$RUN/samples"
OUT="$RUN/save-hash.out"

cat > "$RUN/spike-run.lua" <<EOF
dofile("$LUA")()
EOF

MAME_PID=""
WATCHDOG_PID=""
kill_group() { [[ -n "$1" ]] || return 0; kill -KILL -"$1" 2>/dev/null || true; }
cleanup() {
  kill_group "$WATCHDOG_PID"
  kill_group "$MAME_PID"
  if [[ "$KEEP" -eq 1 ]]; then echo "kept working directory: $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

setsid env \
  WMA_SPIKE_BOOT="$BOOT" WMA_SPIKE_ITERS="$ITERS" WMA_SPIKE_SPAN="$SPAN" \
  WMA_SPIKE_OUT="$OUT" \
  "$BINARY" "$DRIVER" \
  -rompath "$ROMPATH" -samplepath "$RUN/samples" \
  -noreadconfig -skip_gameinfo -nothrottle \
  -video none -sound none -nomouse -nojoystick \
  -cfg_directory "$RUN/cfg" -nvram_directory "$RUN/nvram" \
  -state_directory "$RUN/sta" -snapshot_directory "$RUN/snap" \
  -autoboot_script "$RUN/spike-run.lua" \
  > "$RUN/mame.log" 2>&1 &
MAME_PID=$!
setsid bash -c 'sleep "$1"; kill -KILL -"$2" 2>/dev/null || true' _ "$TIMEOUT" "$MAME_PID" &
WATCHDOG_PID=$!

MAME_RC=0
wait "$MAME_PID" || MAME_RC=$?
kill_group "$WATCHDOG_PID"
wait "$WATCHDOG_PID" 2>/dev/null || true
MAME_PID=""; WATCHDOG_PID=""

if [[ "$MAME_RC" -ne 0 && ! -s "$OUT" ]]; then
  echo "FAILED (mame rc=$MAME_RC)" >&2
  tail -n 20 "$RUN/mame.log" >&2 || true
  exit 1
fi
if [[ ! -s "$OUT" ]]; then
  echo "FAILED (no result written)" >&2
  tail -n 20 "$RUN/mame.log" >&2 || true
  exit 1
fi

cat "$OUT"
DET="$(sed -n 's/^SPIKE_DET=//p' "$OUT" | head -n1)"
echo
if [[ "$DET" == "PASS" ]]; then
  echo "RESULT: PASS (save -> advance -> load round-trip restores the same hash)"
  exit 0
fi
echo "RESULT: FAIL (round-trip hash mismatch or error)" >&2
exit 1
