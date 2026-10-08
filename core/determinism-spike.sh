#!/usr/bin/env bash
# Determinism spike: record a fixed-length session with MAME -record, replay it
# with -playback, and compare a RAM hash computed by a Lua script at the end.
# See docs/tasks/README.md (T02) and docs/01-mame-source-notes.md.
#
# Usage: core/determinism-spike.sh [driver] [options]
#   --frames <n>    emulated frames per run (default 36000 = 10 min @ 60 fps)
#   --rounds <n>    independent record+replay rounds (default 10)
#   --replays <n>   playback runs per round (default 2)
#   --rompath <dir> ROM directory (default <repo>/roms)
#   --binary <path> MAME binary (default <repo>/mame/<driver>)
#   --keep          keep the temporary working directory
#   --dry-run       print the commands that would run, then exit
#   --help          show this help
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LUA="$REPO_ROOT/core/determinism/spike.lua"

# Only drivers verified as MACHINE_SUPPORTS_SAVE with all RAM in memory shares
# (see docs/01-mame-source-notes.md). gridlee is the T02 smoke driver.
declare -A KNOWN_DRIVERS=( [gridlee]=1 )
DEFAULT_DRIVER=gridlee

FRAMES=36000
ROUNDS=10
REPLAYS=2
ROMPATH="$REPO_ROOT/roms"
BINARY=""
RUN_TIMEOUT_OVERRIDE=""
KEEP=0
DRY_RUN=0
DRIVER=""

usage() {
  cat <<EOF
Usage: core/determinism-spike.sh [driver] [options]

Records a fixed-length session with -record, replays it with -playback, and
compares the RAM hash each run reports at the end. Prints "RESULT: PASS" only
if every run produced the same hash.

Options:
  --frames <n>     emulated frames per run (default $FRAMES = 10 min @ 60 fps)
  --rounds <n>     independent record+replay rounds (default $ROUNDS)
  --replays <n>    playback runs per round (default $REPLAYS)
  --rompath <dir>  ROM directory (default $ROMPATH)
  --binary <path>  MAME binary (default <repo>/mame/<driver>)
  --timeout <secs> per-run wall-clock limit (default $((FRAMES / 10 + 120)))
  --keep           keep the temporary working directory
  --dry-run        print the commands that would run, then exit
  --help           show this help

Known drivers: ${!KNOWN_DRIVERS[*]}

A free gridlee.zip ROM is available from https://www.mamedev.org/roms/ and
must be placed in the ROM directory (roms/ is gitignored).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --frames)   FRAMES="${2:?--frames needs a value}"; shift 2 ;;
    --rounds)   ROUNDS="${2:?--rounds needs a value}"; shift 2 ;;
    --replays)  REPLAYS="${2:?--replays needs a value}"; shift 2 ;;
    --rompath)  ROMPATH="${2:?--rompath needs a value}"; shift 2 ;;
    --binary)   BINARY="${2:?--binary needs a value}"; shift 2 ;;
    --timeout)  RUN_TIMEOUT_OVERRIDE="${2:?--timeout needs a value}"; shift 2 ;;
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
for pair in "frames:$FRAMES" "rounds:$ROUNDS" "replays:$REPLAYS"; do
  name="${pair%%:*}"; val="${pair#*:}"
  if [[ ! "$val" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: --$name must be a positive integer (got '$val')" >&2
    exit 2
  fi
done
if [[ -n "$RUN_TIMEOUT_OVERRIDE" && ! "$RUN_TIMEOUT_OVERRIDE" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: --timeout must be a positive integer (got '$RUN_TIMEOUT_OVERRIDE')" >&2
  exit 2
fi
BINARY="${BINARY:-$REPO_ROOT/mame/$DRIVER}"

TOTAL=$((ROUNDS * (1 + REPLAYS)))

# Escape a string for embedding in a Lua double-quoted literal.
lua_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

# Build the shared MAME argument list for one run directory. Record/playback
# filenames are resolved under -input_directory (MAME strips any leading '/'),
# so all runs share INPUT_DIR and refer to the .inp by basename.
build_common_args() {
  local run="$1"
  COMMON_ARGS=(
    -rompath "$ROMPATH"
    -samplepath "$run/samples"
    -noreadconfig -skip_gameinfo -nothrottle
    -video none -sound none -nomouse -nojoystick
    -cfg_directory "$run/cfg"
    -nvram_directory "$run/nvram"
    -input_directory "$INPUT_DIR"
    -state_directory "$run/sta"
    -snapshot_directory "$run/snap"
  )
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  TMP='<tmp>'
  INPUT_DIR="$TMP/inp"
  echo "driver:      $DRIVER"
  echo "binary:      $BINARY"
  echo "lua:         $LUA"
  echo "rompath:     $ROMPATH"
  echo "options:     --frames $FRAMES --rounds $ROUNDS --replays $REPLAYS"
  echo "runs:        $TOTAL ($ROUNDS rounds x (1 record + $REPLAYS replay))"
  echo
  echo "per-run bootstrap (spike-run.lua):"
  echo "  local run = dofile(\"$LUA\")"
  echo "  run(\"record\", $FRAMES, \"$TMP/r1-run0/hash\")"
  echo
  build_common_args "$TMP/r1-run0"
  echo "record (round 1 of $ROUNDS):"
  echo "  $BINARY $DRIVER ${COMMON_ARGS[*]} -autoboot_script $TMP/r1-run0/spike-run.lua -record session-1.inp"
  echo "replay (round 1, 1 of $REPLAYS):"
  echo "  $BINARY $DRIVER ${COMMON_ARGS[*]} -autoboot_script $TMP/r1-run1/spike-run.lua -playback session-1.inp -exit_after_playback"
  echo
  echo "dry-run: nothing was executed."
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
ROM_SHA="$(sha256sum "$ROM_FILE" | cut -d' ' -f1)"
MAME_SHA="$(git -C "$REPO_ROOT/mame" rev-parse HEAD 2>/dev/null || echo unknown)"
RUN_TIMEOUT="${RUN_TIMEOUT_OVERRIDE:-$(( FRAMES / 10 + 120 ))}"

echo "driver:      $DRIVER"
echo "binary:      $BINARY"
echo "binary sha:  $BIN_SHA"
echo "rom sha:     $ROM_SHA"
echo "mame commit: $MAME_SHA"
echo "frames:      $FRAMES"
echo "rounds:      $ROUNDS"
echo "replays:     $REPLAYS"
echo "timeout:     ${RUN_TIMEOUT}s per run"
echo "total runs:  $TOTAL"
echo

TMP="$(mktemp -d)"
INPUT_DIR="$TMP/inp"
mkdir -p "$INPUT_DIR"

# MAME catches SIGTERM and can spin at 100% CPU forever, so a hung run must be
# stopped with SIGKILL. Each run therefore gets its own process group (setsid)
# and the whole group is killed on timeout and on any exit of this script, so an
# interrupted test can never leave orphaned emulator processes behind.
MAME_PID=""
WATCHDOG_PID=""
kill_group() {
  [[ -n "$1" ]] || return 0
  kill -KILL -"$1" 2>/dev/null || true
}
cleanup() {
  kill_group "$WATCHDOG_PID"
  kill_group "$MAME_PID"
  if [[ "$KEEP" -eq 1 ]]; then
    echo "kept working directory: $TMP"
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

hashes=()
labels=()
fail=0

for ((r = 1; r <= ROUNDS; r++)); do
  INP="session-$r.inp"
  for ((i = 0; i <= REPLAYS; i++)); do
    RUN="$TMP/r$r-run$i"
    mkdir -p "$RUN/cfg" "$RUN/nvram" "$RUN/sta" "$RUN/snap" "$RUN/samples"
    OUT="$RUN/hash"
    if [[ "$i" -eq 0 ]]; then MODE=record; else MODE=playback; fi

    cat > "$RUN/spike-run.lua" <<EOF
local run = dofile("$(lua_escape "$LUA")")
run("$MODE", $FRAMES, "$(lua_escape "$OUT")")
EOF

    build_common_args "$RUN"
    if [[ "$MODE" == "record" ]]; then
      MODE_ARGS=(-record "$INP")
    else
      MODE_ARGS=(-playback "$INP" -exit_after_playback)
    fi

    printf 'round %2d %-9s (%d/%d) ... ' "$r" "$MODE" "$i" "$REPLAYS"
    setsid "$BINARY" "$DRIVER" "${COMMON_ARGS[@]}" \
      -autoboot_script "$RUN/spike-run.lua" "${MODE_ARGS[@]}" \
      > "$RUN/mame.log" 2>&1 &
    MAME_PID=$!
    # Watchdog in its own process group: cancelling it below kills its sleep too,
    # so it can never fire against a reused pgid after the run has finished.
    setsid bash -c 'sleep "$1"; kill -KILL -"$2" 2>/dev/null || true' \
      _ "$RUN_TIMEOUT" "$MAME_PID" &
    WATCHDOG_PID=$!

    MAME_RC=0
    wait "$MAME_PID" || MAME_RC=$?
    kill_group "$WATCHDOG_PID"
    wait "$WATCHDOG_PID" 2>/dev/null || true
    MAME_PID=""
    WATCHDOG_PID=""

    if [[ "$MAME_RC" -ne 0 ]]; then
      echo "FAILED"
      echo "--- mame.log (tail) ---" >&2
      tail -n 20 "$RUN/mame.log" >&2 || true
      fail=1
      break 2
    fi

    if [[ ! -s "$OUT" ]]; then
      echo "FAILED (no hash written)"
      tail -n 20 "$RUN/mame.log" >&2 || true
      fail=1
      break 2
    fi
    HASH="$(sed -n 's/^SPIKE_HASH=//p' "$OUT" | head -n1)"
    echo "$HASH"
    hashes+=("$HASH")
    labels+=("r$r/$MODE#$i")
  done
done

if [[ "$fail" -eq 1 ]]; then
  echo
  echo "RESULT: FAIL (a run did not complete)"
  exit 1
fi

if [[ "${#hashes[@]}" -ne "$TOTAL" ]]; then
  echo
  echo "RESULT: FAIL (expected $TOTAL hashes, got ${#hashes[@]})"
  exit 1
fi

REF="${hashes[0]}"
all_equal=1
for idx in "${!hashes[@]}"; do
  if [[ "${hashes[$idx]}" != "$REF" ]]; then
    echo "mismatch ${labels[$idx]}: ${hashes[$idx]} != $REF" >&2
    all_equal=0
  fi
done

echo
if [[ "$all_equal" -eq 1 ]]; then
  echo "reference hash: $REF"
  echo "RESULT: PASS ($TOTAL/$TOTAL runs match)"
  exit 0
else
  echo "RESULT: FAIL (hashes differ)"
  exit 1
fi
