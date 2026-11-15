#!/bin/sh
# One-shot: start the forge, run the conformance suite against it, stop it.
set -eu
cd "$(dirname "$0")"
MAKEFUN_ENV_URL="http://127.0.0.1:1"
export MAKEFUN_ENV_URL
MAKEFUN_SHOP_TOKEN="test-token-12345" node --experimental-strip-types main.ts >/tmp/forge-run.log 2>&1 &
PID=$!
sleep 1.2
PORT=$(sed -n 's/.*listening on 0.0.0.0:\([0-9]*\).*/\1/p' /tmp/forge-run.log | head -1)
if [ -z "$PORT" ]; then echo "no port"; kill $PID 2>/dev/null; exit 1; fi
echo "forge on port $PORT"
cd /root/makefun/github-core-clone-01-kit
node --experimental-strip-types sdk/run.ts --url "http://127.0.0.1:$PORT" --token "test-token-12345" --json "$@" 2>/dev/null
RC=$?
kill $PID 2>/dev/null || true
exit $RC
