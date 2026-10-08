#!/bin/sh
# usage: pw585.sh <playwright args...>   (runs in cwd as ubuntu under the e2e lock)
exec flock /tmp/ovd-e2e.lock runuser -u ubuntu -- env HOME=/tmp/ubuntu-home PLAYWRIGHT_BROWSERS_PATH=/tmp/ubuntu-home/pw-browsers VITE_CACHE_DIR=/tmp/ubuntu-vite-585 PLAYWRIGHT_SKIP_AUTH_SETUP=1 npx playwright test --output=/tmp/ubuntu-home/pwout "$@"
