#!/bin/bash
set -euo pipefail
PKG=$(cd "$(dirname "$0")/.." && pwd)
APP=${CATTT_APP:-"$PKG/build/Cattt.app"}
BIN="$APP/Contents/MacOS/CatttHost"
PG="$APP/Contents/Resources/postgres/bin"
if pgrep -x redis-server >/dev/null; then echo '烟测要求无 redis-server 进程'; exit 1; fi
mkdir -p "$PKG/build/smoke"
DATA=$(mktemp -d "$PKG/build/smoke/run.XXXXXX")
PID=
stop() { if [ -n "$PID" ]; then kill -TERM "$PID"; wait "$PID"; PID=; fi; }
trap stop EXIT
echo "烟测数据：$DATA"
printf '# 烟测\n' > "$DATA/env"
chmod 600 "$DATA/env"
start() {
  "$BIN" --headless --data-dir "$DATA" >"$DATA/stdout.log" 2>&1 & PID=$!
  for _ in $(seq 1 120); do
    if ! kill -0 "$PID" 2>/dev/null; then cat "$DATA/stdout.log"; cat "$DATA/logs/host.log"; exit 1; fi
    if [ "$(curl -s -o "$DATA/health.json" -w '%{http_code}' http://127.0.0.1:8787/healthz || true)" = 200 ]; then echo '/healthz 200'; return; fi
    sleep 1
  done
  cat "$DATA"/logs/*.log; exit 1
}
db() { PGPASSWORD=$(cat "$DATA/pg-password") "$PG/psql" -h 127.0.0.1 -p 54329 -U cattt -d cattt -v ON_ERROR_STOP=1 "$@"; }
start
test -z "$(rg 'MODEL_PROVIDER|API_KEY' "$DATA/env" || true)"
pgrep -P "$PID" -fl 'api.mjs|worker.mjs'
test -n "$(pgrep -P "$PID" -f worker.mjs)"
cat "$DATA/health.json"
echo
"$APP/Contents/Resources/node/bin/node" -e 'const h=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); if(h.ok!==true || h.db!==true || "redis" in h) process.exit(1)' "$DATA/health.json"
echo '无 Redis：/healthz 200，ok=true，db=true，无 redis 字段'
echo '无模型 key / 无 MODEL_PROVIDER：API 和 worker 已启动，/healthz 200'
if "$BIN" --headless --data-dir "$DATA" --backup >"$DATA/duplicate.log" 2>&1; then echo '单实例保护失效'; exit 1; fi
rg '宿主已经运行' "$DATA/duplicate.log"
lsof -nP -iTCP:54329 -sTCP:LISTEN | tee "$DATA/listen.txt"
if rg -q '\*:54329|\[::\]|0\.0\.0\.0:54329' "$DATA/listen.txt"; then exit 1; fi
rg '127\.0\.0\.1:54329' "$DATA/listen.txt"
API_PID=$(pgrep -P "$PID" -f api.mjs)
kill -KILL "$API_PID"
for _ in $(seq 1 20); do
  sleep 1
  NEW_API_PID=$(pgrep -P "$PID" -f api.mjs || true)
  if [ -n "$NEW_API_PID" ] && [ "$NEW_API_PID" != "$API_PID" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/healthz || true)" = 200 ]; then break; fi
done
test -n "$NEW_API_PID"
test "$NEW_API_PID" != "$API_PID"
echo 'API 崩溃后自动重启，/healthz 200'
db -c 'CREATE TABLE host_smoke(value text); INSERT INTO host_smoke VALUES ($$保留$$)'
printf '证书测试' > "$DATA/tls/smoke"
printf 'token-test' > "$DATA/host-admin.token"
stop
"$BIN" --headless --data-dir "$DATA" --backup
BACKUP=$(find "$DATA/backups" -mindepth 1 -maxdepth 1 -type d ! -name '*pre-upgrade' | sort | tail -1)
start
db -c 'UPDATE host_smoke SET value=$$修改$$'
stop
printf 'changed' > "$DATA/tls/smoke"
"$BIN" --headless --data-dir "$DATA" --restore "$BACKUP"
start
test "$(db -tAc 'SELECT value FROM host_smoke')" = 保留
test "$(cat "$DATA/tls/smoke")" = 证书测试
test "$(cat "$DATA/host-admin.token")" = token-test
test "$(stat -f %Lp "$DATA/env")" = 600
test "$(stat -f %Lp "$DATA/pg-password")" = 600
cmp "$DATA/env" "$BACKUP/env"
stop
printf '{"lastVersion":"older-version"}' > "$DATA/host-state.json"
start
test "$(db -tAc 'SELECT value FROM host_smoke')" = 保留
test "$(find "$DATA/backups" -name '*pre-upgrade' -type d | wc -l | tr -d ' ')" -ge 1
stop
echo 'PASS: 初始化、迁移、备份、恢复、升级保留数据与 TLS/token/env、PG 仅监听 127.0.0.1'
