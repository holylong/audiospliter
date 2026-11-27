#!/usr/bin/env bash
# 一键启动双人对话分离 app：清掉旧进程 → 起服务（默认监听局域网）→ 打印访问地址
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8010}"
HOST="${HOST:-0.0.0.0}"     # HOST=127.0.0.1 只给本机
PY=.venv/bin/python
[ -x "$PY" ] || { echo "缺少 .venv，先执行 uv venv .venv 并安装依赖（见 README）"; exit 1; }

# 端口被上一次的服务占着时先收掉
OLD=$(ss -ltnp 2>/dev/null | grep ":${PORT}" | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "${OLD}" ]; then
  kill "${OLD}" 2>/dev/null || true
  sleep 1
  echo "已停止占用 ${PORT} 的旧服务 (pid ${OLD})"
fi

# 找一块能被局域网访问的网卡地址：优先 192.168/10.x，跳过 docker/tun 虚拟网卡
lan_ip() {
  ip -4 -o addr show scope global 2>/dev/null \
    | awk '{split($4, a, "/"); print $2, a[1]}' \
    | grep -vE '^(docker|br-|veth|virbr|tun|tap|tailscale|zt)' \
    | awk '{print $2}' \
    | awk '
        /^192\.168\./ {best=$0; exit}
        /^10\./       {if (mid=="") mid=$0}
        /^172\.(1[6-9]|2[0-9]|3[01])\./ {if (priv=="") priv=$0}
        END { if (best!="") print best; else if (mid!="") print mid; else print priv }
      '
}

mkdir -p build
HF_HUB_OFFLINE=1 "$PY" -m uvicorn app.server:app --host "${HOST}" --port "${PORT}" > build/server.log 2>&1 &
SRV=$!

for _ in $(seq 1 40); do
  if curl -sf -m 2 "http://127.0.0.1:${PORT}/api/health" > /dev/null; then break; fi
  sleep 0.5
done
if ! curl -sf -m 2 "http://127.0.0.1:${PORT}/api/health" > /dev/null; then
  echo "服务没起来，看 build/server.log："; tail -20 build/server.log; exit 1
fi

IP=$(lan_ip || true)
echo "本机    → http://127.0.0.1:${PORT}"
if [ "${HOST}" = "0.0.0.0" ] && [ -n "${IP}" ]; then
  echo "局域网  → http://${IP}:${PORT}   （手机/平板连同一个 WiFi 直接打开）"
  echo "          若打不开，检查防火墙：sudo ufw allow ${PORT}/tcp"
fi
echo "示例音频 → samples/双人对话_30s.wav（页面里点「使用示例对话」也行）"
echo "只给本机用：HOST=127.0.0.1 ./start.sh"

command -v xdg-open > /dev/null && xdg-open "http://127.0.0.1:${PORT}" > /dev/null 2>&1 &
wait $SRV
