#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export ASTRASHOP_PORT="${STRESS_PORT:-0}"
export LOCAL_UID="$(id -u)"
export LOCAL_GID="$(id -g)"
stress_project="astrashop-stress-$(date +%s)-$$"
compose() { docker compose --project-name "$stress_project" -f compose.yaml -f compose.stress.yaml "$@"; }
cleanup() { compose down --volumes >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir -p artifacts
compose up --build --wait --wait-timeout 180
stress_status=0
compose run --rm --no-deps loadgen || stress_status=$?
if [ "$stress_status" -eq 0 ]; then
  probe() {
    compose exec -T app node --input-type=module - "$1" < backend/recovery-probe.mjs
    compose exec -T app cat /tmp/recovery-report.json > "artifacts/recovery-$1.json"
  }
  compose stop redis
  probe outage-redis
  compose start redis
  probe restored-redis
  compose stop dynamodb
  probe outage-database
  compose start dynamodb
  probe restored-database
  compose restart app
  probe restored-app
fi
printf '\nStress report saved to artifacts/stress-report.json\n'
exit "$stress_status"
