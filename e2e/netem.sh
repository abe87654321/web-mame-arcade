#!/usr/bin/env bash
# Run the netplay e2e spec under Linux `tc netem` profiles (T26, docs/03).
# Needs root (sudo) to shape loopback; local-only, never part of CI.
#
# Usage:
#   pnpm --filter @wma/e2e test:e2e:netem            # all default profiles
#   bash netem.sh "50ms 0%"                          # one profile (delay loss)
set -euo pipefail
cd "$(dirname "$0")"

profiles=("50ms 1%" "100ms 1%" "150ms 1%")
if [ "$#" -gt 0 ]; then
  profiles=("$*")
fi

rc=0
for profile in "${profiles[@]}"; do
  # Split "<delay> <loss>" into the two netem arguments.
  read -r delay loss <<<"$profile"
  echo "== netem delay=$delay loss=$loss =="
  sudo tc qdisc replace dev lo root netem delay "$delay" loss "$loss"
  if pnpm exec playwright test; then
    echo "== PASS (delay=$delay loss=$loss) =="
  else
    rc=1
    echo "== FAIL (delay=$delay loss=$loss) =="
  fi
  sudo tc qdisc del dev lo root || true
done

exit "$rc"
