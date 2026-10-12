#!/usr/bin/env bash
# Publish a built WASM core (and its scoremap, if any) into the web app's
# public/ directory and point packages/web/public/games.json at the new core
# hash. The core hash is the sha256 of the freshly built .wasm, so this runs
# AFTER core/build-wasm.sh <driver>.
#
# Usage: core/publish-web.sh <driver> [--core-hash <hash>] [--dry-run] | --help
set -euo pipefail

export LC_ALL=C

# WMA_REPO_ROOT is a test hook; normally derive the repo from this script.
REPO_ROOT="${WMA_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
OUT_ROOT="$REPO_ROOT/core/out"
PUBLIC="$REPO_ROOT/packages/web/public"
GAMES="$PUBLIC/games.json"
SCOREMAP_SRC_DIR="$REPO_ROOT/core/scoremap"
SCOREMAP_DST_DIR="$PUBLIC/static/scoremap"

usage() {
  cat <<EOF
Usage: core/publish-web.sh <driver> [--core-hash <hash>] [--dry-run]

Copies core/out/<driver>/<hash>/ into
packages/web/public/static/cores/<driver>/<core_hash>/, updates the <driver>
entry's coreVersion (and mameCommit) in packages/web/public/games.json, and
copies core/scoremap/<driver>.json into public/static/scoremap/ when present.

  --core-hash <hash>  publish this build instead of the newest one
  --dry-run           print what would happen; write nothing

Run core/build-wasm.sh <driver> first: the <core_hash> is the .wasm sha256.
EOF
}

DRIVER=""
HASH=""
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --core-hash) HASH="${2:?--core-hash needs a value}"; shift 2 ;;
    --dry-run)   DRY_RUN=1; shift ;;
    --help|-h)   usage; exit 0 ;;
    -*)          echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)           DRIVER="$1"; shift ;;
  esac
done

if [[ -z "$DRIVER" ]]; then usage >&2; exit 2; fi

DRIVER_DIR="$OUT_ROOT/$DRIVER"
if [[ ! -d "$DRIVER_DIR" ]]; then
  echo "error: no build for '$DRIVER' under $DRIVER_DIR (run core/build-wasm.sh $DRIVER)" >&2
  exit 3
fi

if [[ -z "$HASH" ]]; then
  # Newest build by manifest mtime; empty when no build has a manifest yet.
  HASH="$(find "$DRIVER_DIR" -mindepth 2 -maxdepth 2 -name manifest.json -printf '%T@ %h\n' 2>/dev/null \
    | sort -rn | head -1 | awk '{print $2}' | xargs -r basename)"
fi
if [[ -z "$HASH" ]]; then
  echo "error: no built core found under $DRIVER_DIR" >&2
  exit 3
fi

BUILD_DIR="$DRIVER_DIR/$HASH"
MANIFEST="$BUILD_DIR/manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
  echo "error: missing $MANIFEST" >&2
  exit 3
fi

CORE_HASH="$(node -e 'process.stdout.write(require(process.argv[1]).core_hash)' "$MANIFEST")"
MAME_COMMIT="$(node -e 'process.stdout.write(require(process.argv[1]).mame_commit || "")' "$MANIFEST")"
DEST="$PUBLIC/static/cores/$DRIVER/$CORE_HASH"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "driver:      $DRIVER"
  echo "build dir:   $BUILD_DIR"
  echo "core hash:   $CORE_HASH"
  echo "publish to:  $DEST"
  echo "games.json:  $DRIVER coreVersion -> $CORE_HASH"
  echo "scoremap:    core/scoremap/$DRIVER.json -> public/static/scoremap/ (if present)"
  exit 0
fi

if [[ ! -f "$GAMES" ]]; then
  echo "error: missing $GAMES" >&2
  exit 3
fi

mkdir -p "$DEST"
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  cp "$BUILD_DIR/$name" "$DEST/$name"
done < <(node -e 'for (const n of Object.keys(require(process.argv[1]).artifacts)) console.log(n)' "$MANIFEST")
cp "$MANIFEST" "$DEST/manifest.json"

node - "$GAMES" "$DRIVER" "$CORE_HASH" "$MAME_COMMIT" <<'NODE'
const fs = require("fs");
const [file, driver, coreVersion, mameCommit] = process.argv.slice(2);
const games = JSON.parse(fs.readFileSync(file, "utf8"));
const entry = games.find((game) => game.driver === driver);
if (!entry) {
  console.error(`error: no '${driver}' entry in ${file}`);
  process.exit(4);
}
entry.coreVersion = coreVersion;
if (mameCommit) entry.mameCommit = mameCommit;
fs.writeFileSync(file, JSON.stringify(games, null, 2) + "\n");
NODE

if [[ -f "$SCOREMAP_SRC_DIR/$DRIVER.json" ]]; then
  mkdir -p "$SCOREMAP_DST_DIR"
  cp "$SCOREMAP_SRC_DIR/$DRIVER.json" "$SCOREMAP_DST_DIR/$DRIVER.json"
  SCOREMAP_NOTE="published"
else
  SCOREMAP_NOTE="none (browser shows no live score)"
fi

echo "driver:      $DRIVER"
echo "core hash:   $CORE_HASH"
echo "published:   $DEST"
echo "games.json:  coreVersion set"
echo "scoremap:    $SCOREMAP_NOTE"
