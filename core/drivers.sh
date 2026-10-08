#!/usr/bin/env bash
# Shared driver -> comma-separated SOURCES map for core/build-native.sh and
# core/build-wasm.sh. Sourced, not executed. Free ROMs: https://www.mamedev.org/roms/
declare -A DRIVER_SOURCES=(
  [gridlee]="src/mame/bally/gridlee.cpp,src/mame/bally/gridlee_a.cpp,src/mame/bally/gridlee_v.cpp"
)
