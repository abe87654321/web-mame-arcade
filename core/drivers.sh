#!/usr/bin/env bash
# Shared driver -> comma-separated SOURCES map for core/build-native.sh and
# core/build-wasm.sh. Sourced, not executed.
#
# Gridlee is a free ROM from https://www.mamedev.org/roms/ and the git-committed
# smoke driver. twinbee/raiden/raiden2/twincobr are commercial ROMs kept in the
# gitignored roms/ for LOCAL development only (docs/07): never commit their zips
# or builds. The listed split files are what MAME's makedep resolves for each
# driver; giving just the main file is equivalent, but listing them keeps the
# mapping explicit.
#
# twincobr is SOLO-ONLY: its GAME flags omit MACHINE_SUPPORTS_SAVE (toaplan/
# twincobr.cpp), so it has no save state and cannot netplay or replay
# (AGENTS.md: out of scope for v1). It is built and catalogued with
# netplayMode "none" for offline play/verification only.
declare -A DRIVER_SOURCES=(
  [gridlee]="src/mame/bally/gridlee.cpp,src/mame/bally/gridlee_a.cpp,src/mame/bally/gridlee_v.cpp"
  [twinbee]="src/mame/konami/nemesis.cpp,src/mame/konami/nemesis_v.cpp"
  [raiden]="src/mame/seibu/raiden.cpp"
  [raiden2]="src/mame/seibu/raiden2.cpp,src/mame/seibu/raiden2_v.cpp"
  [twincobr]="src/mame/toaplan/twincobr.cpp,src/mame/toaplan/twincobr_m.cpp,src/mame/toaplan/twincobr_v.cpp"
)
