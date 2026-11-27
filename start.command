#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v docker >/dev/null 2>&1; then
  printf 'Install Docker Desktop from https://www.docker.com/products/docker-desktop/ and run this file again.\n'
  exit 1
fi
if ! docker info >/dev/null 2>&1 && command -v open >/dev/null 2>&1; then
  open -a Docker
  astrashop_attempt=0
  until docker info >/dev/null 2>&1; do
    astrashop_attempt=$((astrashop_attempt + 1))
    if [ "$astrashop_attempt" -ge 60 ]; then printf 'Docker is not ready. Start Docker Desktop and retry.\n'; exit 1; fi
    sleep 2
  done
fi
docker compose up --build --wait --wait-timeout 180
astrashop_address="$(docker compose port app 8080)"
astrashop_url="http://localhost:${astrashop_address##*:}"
printf '\nAstraShop is ready at %s\n' "$astrashop_url"
if command -v open >/dev/null 2>&1; then open "$astrashop_url"; fi
