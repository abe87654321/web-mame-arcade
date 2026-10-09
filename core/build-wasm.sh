#!/usr/bin/env bash
# Build one free MAME driver to WebAssembly with the pinned emsdk and MAME
# commit, and publish it under core/out/<driver>/<core_hash>/.
# Usage: core/build-wasm.sh <driver> [--dry-run] | --list-drivers | --help
set -euo pipefail

# Deterministic string handling regardless of the caller's locale.
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAME_DIR="$REPO_ROOT/mame"
OUT_ROOT="$REPO_ROOT/core/out"
APPLY="$REPO_ROOT/core/patches/apply.sh"

# Single source of truth for the pins (mirrored in docs/02-emulation-core.md).
VERSIONS_FILE="$REPO_ROOT/core/versions.json"
read_pin() {
  if ! command -v node >/dev/null 2>&1; then
    echo "error: node is required to read pinned versions from $VERSIONS_FILE" >&2
    exit 3
  fi
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]] || "")' \
    "$VERSIONS_FILE" "$1"
}

# Shared driver -> comma-separated SOURCES map (same source list as the native build).
source "$REPO_ROOT/core/drivers.sh"

usage() {
  cat <<EOF
Usage: core/build-wasm.sh <driver> [--dry-run]
       core/build-wasm.sh --list-drivers
       core/build-wasm.sh --help

Builds a single driver to WebAssembly (emmake make SUBTARGET=<driver> SOURCES=...)
with the pinned emsdk and MAME commit, then copies the artifacts to
core/out/<driver>/<core_hash>/ and writes manifest.json. <core_hash> is the
sha256 of the .wasm file (the cross-peer identity key, contracts/core-version.md).

Requires a sourced emsdk (source emsdk_env.sh) providing emcc/emmake at the
pinned version, prepared SDL libs, and an initialised mame/.

Known drivers: ${!DRIVER_SOURCES[*]}
EOF
}

DRY_RUN=0
EMSDK_DIR="${EMSDK:-}"
DRIVER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)      DRY_RUN=1; shift ;;
    --emsdk)        EMSDK_DIR="${2:?--emsdk needs a value}"; shift 2 ;;
    --list-drivers) printf '%s\n' "${!DRIVER_SOURCES[@]}"; exit 0 ;;
    --help|-h)      usage; exit 0 ;;
    -*)             echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)              DRIVER="$1"; shift ;;
  esac
done

if [[ -z "$DRIVER" ]]; then usage >&2; exit 2; fi
if [[ -z "${DRIVER_SOURCES[$DRIVER]:-}" ]]; then
  echo "unknown driver: $DRIVER" >&2; usage >&2; exit 2
fi

SOURCES="${DRIVER_SOURCES[$DRIVER]}"
if command -v nproc >/dev/null 2>&1; then JOBS="$(nproc)"; else JOBS=4; fi

EMSDK_PIN="$(read_pin emsdk)"
MAME_PIN="$(read_pin mameCommit)"

# MAME names the single-driver project "mame" + SUBTARGET (makefile:959-962),
# so with the default TARGET the artifacts are mame<driver>.{js,wasm,html}.
PREFIX="mame$DRIVER"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "driver:      $DRIVER"
  echo "mame commit: $MAME_PIN"
  echo "emsdk:       $EMSDK_PIN"
  echo "output:      $OUT_ROOT/$DRIVER/<core_hash>/"
  echo
  echo "embuilder build sdl3 sdl3_ttf"
  echo "bash $APPLY apply"
  echo "emmake make -C $MAME_DIR SUBTARGET=$DRIVER SOURCES=$SOURCES IGNORE_GIT=1 NEW_GIT_VERSION=$MAME_PIN -j$JOBS"
  exit 0
fi

if [[ ! -e "$MAME_DIR/makefile" ]]; then
  echo "error: mame/ submodule not initialised (run: git submodule update --init --depth 1)" >&2
  exit 3
fi

MAME_SHA="$(git -C "$MAME_DIR" rev-parse HEAD)"
if [[ "$MAME_SHA" != "$MAME_PIN" ]]; then
  echo "error: mame/ is at $MAME_SHA but the pinned commit is $MAME_PIN" >&2
  echo "       run: git -C mame checkout $MAME_PIN" >&2
  exit 5
fi
# Uncommitted changes to tracked sources would silently produce a different core
# than the recorded mame_commit. Untracked build outputs are expected and ignored.
if ! git -C "$MAME_DIR" diff --quiet || ! git -C "$MAME_DIR" diff --cached --quiet; then
  echo "error: mame/ has uncommitted changes to tracked files; not reproducible from $MAME_PIN" >&2
  echo "       run: git -C mame checkout -- . && git -C mame reset" >&2
  exit 5
fi

# Resolve the emsdk root: --emsdk, $EMSDK, or derived from emcc on the PATH.
if [[ -z "$EMSDK_DIR" ]]; then
  emcc_path="$(command -v emcc || true)"
  if [[ -n "$emcc_path" ]]; then
    emcc_real="$(readlink -f "$emcc_path")"
    if [[ "$emcc_real" == */upstream/emscripten/emcc ]]; then
      EMSDK_DIR="$(cd "$(dirname "$emcc_real")/../.." && pwd)"
    fi
  fi
fi
if [[ -z "$EMSDK_DIR" ]]; then
  echo "error: emsdk not found; source it first (source emsdk_env.sh) or pass --emsdk <dir>" >&2
  echo "       pinned version: $EMSDK_PIN" >&2
  exit 6
fi

EMSCRIPTEN_DIR="$EMSDK_DIR/upstream/emscripten"
EMCC="$EMSCRIPTEN_DIR/emcc"
EMMAKE="$EMSCRIPTEN_DIR/emmake"
EMBUILDER="$EMSCRIPTEN_DIR/embuilder"
for tool in "$EMCC" "$EMMAKE" "$EMBUILDER" \
  "$EMSCRIPTEN_DIR/em++" "$EMSCRIPTEN_DIR/emar"; do
  if [[ ! -x "$tool" ]]; then
    echo "error: expected emsdk tool not found: $tool" >&2
    exit 6
  fi
done

# MAME's generated Makefile compiles via $(EMSDK)/emcc (scripts/toolchain.lua:110-112),
# so export exactly the toolchain we verify below rather than trusting the ambient
# environment. EMCC_CFLAGS is appended to every emcc/em++ call: Clang 23 (emsdk
# 6.0.2) promotes the residfp `friend class State` vs `struct State` tag mismatch
# to an error under MAME's -Werror, so silence just that one warning while keeping
# -Werror for everything else.
export EMSDK="$EMSDK_DIR"
export EMSCRIPTEN="$EMSCRIPTEN_DIR"
export EMCC_CFLAGS="${EMCC_CFLAGS:-} -Wno-mismatched-tags"

EMCC_VERSION="$("$EMCC" --version 2>/dev/null | sed -n '1s/.*) \([0-9][0-9.]*\).*/\1/p')"
if [[ "$EMCC_VERSION" != "$EMSDK_PIN" ]]; then
  echo "error: emcc reports '$EMCC_VERSION' but the pinned emsdk is '$EMSDK_PIN'" >&2
  echo "       install/activate with: ./emsdk install $EMSDK_PIN && ./emsdk activate $EMSDK_PIN" >&2
  exit 6
fi

# SDL libraries are required by MAME's browser build. Idempotent (cached).
"$EMBUILDER" build sdl3 sdl3_ttf

# Add the netplay patch to the pristine submodule, and always remove it again so
# the tracked tree is clean for the next build. The patch hash identifies the
# exact source that produced core_hash.
NETPLAY_PATCH_HASH="$(bash "$APPLY" hash)"
bash "$APPLY" apply
trap 'bash "$APPLY" revert' EXIT

# IGNORE_GIT/NEW_GIT_VERSION pin the embedded revision so a fixed commit builds
# reproducibly. Do NOT pass STRIP_SYMBOLS=1: scripts/toolchain.lua:617 then adds
# an obsolete "asmjs finalize" emcc pass that feeds the already-linked
# <driver>.html back into wasm-ld and fails. The normal em++ link already emits
# .html/.js/.wasm because asmjs sets the target extension (scripts/src/main.lua:86).
"$EMMAKE" make -C "$MAME_DIR" \
  SUBTARGET="$DRIVER" \
  SOURCES="$SOURCES" \
  IGNORE_GIT=1 \
  NEW_GIT_VERSION="$MAME_SHA" \
  -j"$JOBS"

# Locate the emitted artifacts (mame<driver>.* primary, <driver>.* fallback).
BASE=""
WASM=""
for cand in "$MAME_DIR/$PREFIX" "$MAME_DIR/$DRIVER"; do
  if [[ -f "$cand.wasm" ]]; then BASE="$cand"; WASM="$cand.wasm"; break; fi
done
if [[ -z "$WASM" ]]; then
  echo "error: no .wasm artifact found; looked for $PREFIX.wasm and $DRIVER.wasm in $MAME_DIR" >&2
  exit 4
fi

CORE_HASH="$(sha256sum "$WASM" | cut -d' ' -f1)"
OUT_DIR="$OUT_ROOT/$DRIVER/$CORE_HASH"
mkdir -p "$OUT_DIR"

ARTIFACTS=()
for ext in js wasm html data; do
  if [[ -f "$BASE.$ext" ]]; then
    name="$(basename "$BASE.$ext")"
    cp "$BASE.$ext" "$OUT_DIR/$name"
    ARTIFACTS+=("$name")
  fi
done

# The manifest records a sha256 per artifact so the loader/glue (.js) is covered
# too, not just the .wasm that defines core_hash.
{
  printf '{\n'
  printf '  "driver": "%s",\n' "$DRIVER"
  printf '  "core_hash": "%s",\n' "$CORE_HASH"
  printf '  "mame_commit": "%s",\n' "$MAME_SHA"
  printf '  "emsdk": "%s",\n' "$EMSDK_PIN"
  printf '  "netplay_patch": "%s",\n' "$NETPLAY_PATCH_HASH"
  printf '  "artifacts": {\n'
  last=$((${#ARTIFACTS[@]} - 1))
  for i in "${!ARTIFACTS[@]}"; do
    name="${ARTIFACTS[$i]}"
    sum="$(sha256sum "$OUT_DIR/$name" | cut -d' ' -f1)"
    if [[ "$i" -eq "$last" ]]; then comma=""; else comma=","; fi
    printf '    "%s": "%s"%s\n' "$name" "$sum" "$comma"
  done
  printf '  }\n'
  printf '}\n'
} > "$OUT_DIR/manifest.json"

echo "driver:      $DRIVER"
echo "mame commit: $MAME_SHA"
echo "emsdk:       $EMSDK_PIN"
echo "core hash:   $CORE_HASH"
echo "output:      $OUT_DIR"
echo "$CORE_HASH  $OUT_DIR"
