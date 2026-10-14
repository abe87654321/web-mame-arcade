#!/usr/bin/env bash
# T46 native save/load *continuation* probe.
#
# Boots one built native driver headless and checks that `buffer_load(save())`
# followed by the same frames reproduces the uninterrupted future (RAM hash and
# full save buffer). Unlike core/spike/native-save-hash.sh, it steps *after* the
# load, which is the invariant netplay recovery, viewer late-join and replay
# depend on. Needs a built native binary (core/build-native.sh <driver>) and the
# ROM (gitignored).
#
# Usage: core/spike/native-save-continuation.sh [driver] [options]
#   --boot <n>      frames to boot before the save (default 120)
#   --span <n>      frames to advance before/after the load (default 120)
#   --rompath <dir> ROM directory (default <repo>/roms)
#   --binary <path> MAME binary (default <repo>/mame/<driver>)
#   --timeout <secs> wall-clock limit (default 180)
#   --keep          keep the temporary working directory
#   --dry-run       print the command that would run, then exit
#   --help          show this help
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LUA="$REPO_ROOT/core/spike/save-continuation.lua"

BOOT=120
SPAN=120
ROMPATH="$REPO_ROOT/roms"
BINARY=""
KEEP=0
DRY_RUN=0
DRIVER=""

usage() {
  cat <<EOF
Usage: core/spike/native-save-continuation.sh [driver] [options]

Prints "RESULT: PASS" iff save -> advance -> load -> advance reproduces the
uninterrupted future.

Options:
  --boot <n>       frames to boot before the save (default $BOOT)
  --span <n>       frames to advance before/after the load (default $SPAN)
  --rompath <dir>  ROM directory (default $ROMPATH)
  --binary <path>  MAME binary (default <repo>/mame/<driver>)
  --timeout <secs> wall-clock limit (default 180)
  --keep           keep the temporary working directory
  --dry-run        print the command that would run, then exit
  --help           show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --boot)     BOOT="${2:?--boot needs a value}"; shift 2 ;;
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

DRIVER="${DRIVER:-gridlee}"
for pair in "boot:$BOOT" "span:$SPAN"; do
  name="${pair%%:*}"; val="${pair#*:}"
  if [[ ! "$val" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: --$name must be a positive integer (got '$val')" >&2
    exit 2
  fi
done
BINARY="${BINARY:-$REPO_ROOT/mame/$DRIVER}"
TIMEOUT="${TIMEOUT:-180}"
ROM_FILE="$ROMPATH/$DRIVER.zip"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "driver:  $DRIVER"
  echo "binary:  $BINARY"
  echo "lua:     $LUA"
  echo "rompath: $ROMPATH"
  echo "options: --boot $BOOT --span $SPAN"
  exit 0
fi

if [[ ! -x "$BINARY" ]]; then
  echo "error: MAME binary not found or not executable: $BINARY" >&2
  echo "       build it with: core/build-native.sh $DRIVER" >&2
  exit 3
fi
if [[ ! -f "$ROM_FILE" ]]; then
  echo "error: ROM not found: $ROM_FILE" >&2
  exit 4
fi
if [[ ! -f "$LUA" ]]; then
  echo "error: Lua script not found: $LUA" >&2
  exit 3
fi

BIN_SHA="$(sha256sum "$BINARY" | cut -d' ' -f1)"
MAME_SHA="$(git -C "$REPO_ROOT/mame" rev-parse HEAD 2>/dev/null || echo unknown)"

echo "driver:      $DRIVER"
echo "binary:      $BINARY"
echo "binary sha:  $BIN_SHA"
echo "mame commit: $MAME_SHA"
echo "options:     --boot $BOOT --span $SPAN"
echo

TMP="$(mktemp -d)"
RUN="$TMP/run"
mkdir -p "$RUN/cfg" "$RUN/nvram" "$RUN/sta" "$RUN/snap" "$RUN/samples"
OUT="$RUN/save-continuation.out"

cat > "$RUN/si-run.lua" <<EOF
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

DEBUG_ENV=()
[[ -n "${WMA_SI_DEBUG:-}" ]] && DEBUG_ENV=(WMA_SI_DEBUG="$WMA_SI_DEBUG")
setsid env \
  WMA_SI_BOOT="$BOOT" WMA_SI_SPAN="$SPAN" WMA_SI_OUT="$OUT" "${DEBUG_ENV[@]}" \
  "$BINARY" "$DRIVER" \
  -rompath "$ROMPATH" -samplepath "$RUN/samples" \
  -noreadconfig -skip_gameinfo -nothrottle \
  -video none -sound none -nomouse -nojoystick \
  -cfg_directory "$RUN/cfg" -nvram_directory "$RUN/nvram" \
  -state_directory "$RUN/sta" -snapshot_directory "$RUN/snap" \
  -autoboot_script "$RUN/si-run.lua" \
  > "$RUN/mame.log" 2>&1 &
MAME_PID=$!
setsid bash -c 'sleep "$1"; kill -KILL -"$2" 2>/dev/null || true' _ "$TIMEOUT" "$MAME_PID" &
WATCHDOG_PID=$!

MAME_RC=0
wait "$MAME_PID" || MAME_RC=$?
kill_group "$WATCHDOG_PID"
wait "$WATCHDOG_PID" 2>/dev/null || true
MAME_PID=""; WATCHDOG_PID=""

if [[ ! -s "$OUT" ]]; then
  echo "FAILED (no result written; mame rc=$MAME_RC)" >&2
  tail -n 20 "$RUN/mame.log" >&2 || true
  exit 1
fi

cat "$OUT"
DET="$(sed -n 's/^SI_DET=//p' "$OUT" | head -n1)"
echo
if [[ "$DET" == "PASS" ]]; then
  echo "RESULT: PASS (reload reproduces the uninterrupted future)"
  exit 0
fi
echo "RESULT: FAIL (continuation hash mismatch)" >&2
exit 1
