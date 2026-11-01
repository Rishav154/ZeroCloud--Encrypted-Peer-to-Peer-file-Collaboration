#!/bin/bash
set -euo pipefail

if ! psql --username "$POSTGRES_USER" --dbname postgres --tuples-only --no-align \
  --command "SELECT 1 FROM pg_database WHERE datname = 'zerocloud_test'" | grep -q 1; then
  createdb --username "$POSTGRES_USER" zerocloud_test
fi
