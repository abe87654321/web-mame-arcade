#!/usr/bin/env bash
# Run the netplay e2e spec under Linux `tc netem` profiles (T26, docs/03).
# Needs root (sudo) to shape loopback; local-only, never part of CI.
#
# Only UDP is shaped: netplay inputs ride WebRTC's SCTP-over-DTLS-over-UDP data
# channel, while the relay control WS, the Vite dev server (page + WASM core
# load) and the test driver are TCP. Shaping only UDP therefore degrades the
# peer-to-peer transport under test without stalling the harness's own control
# plane (which whole-device `netem` does, making high-delay runs flaky).
#
# Usage:
#   pnpm --filter @wma/e2e test:e2e:netem            # all default profiles
#   bash netem.sh "50ms 0%"                          # one profile (delay loss)
#   bash netem.sh "100ms 1%" -g "netplay rollback"   # extra Playwright args
set -euo pipefail
cd "$(dirname "$0")"

profiles=("50ms 1%" "100ms 1%" "150ms 1%")
extra=()
if [ "$#" -gt 0 ]; then
  profiles=("$1")
  shift
  extra=("$@")
fi

cleanup() { sudo tc qdisc del dev lo root 2>/dev/null || true; }

rc=0
for profile in "${profiles[@]}"; do
  # Split "<delay> <loss>" into the two netem arguments.
  read -r delay loss <<<"$profile"
  echo "== netem (udp only) delay=$delay loss=$loss =="
  cleanup
  # prio root: band 3 carries netem; a u32 filter sends only UDP there, so TCP
  # stays on the default (clean) band.
  sudo tc qdisc add dev lo root handle 1: prio
  sudo tc qdisc add dev lo parent 1:3 handle 30: netem delay "$delay" loss "$loss"
  sudo tc filter add dev lo protocol ip parent 1:0 prio 3 u32 match ip protocol 17 0xff flowid 1:3
  # IPv6 candidates (if any) too; ignore if the kernel u32 ip6 selector differs.
  sudo tc filter add dev lo protocol ipv6 parent 1:0 prio 3 u32 match ip6 protocol 17 0xff flowid 1:3 || true

  if pnpm exec playwright test "${extra[@]}"; then
    echo "== PASS (delay=$delay loss=$loss) =="
  else
    rc=1
    echo "== FAIL (delay=$delay loss=$loss) =="
  fi
  cleanup
done

exit "$rc"
