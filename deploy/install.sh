#!/usr/bin/env bash
# 神枢网卡执行脑 — 一条命令装到任意 Debian/Ubuntu 机器上
#
#   sudo bash deploy/install.sh
#
# 装完做了什么：
#   1. 装齐网卡工具（tcpdump / traceroute / iproute2）与 Node 20+（缺才装）
#   2. 生成随机 TASK_TOKEN，写进 /etc/nexus-nic-brain.env（权限 600，只有 root 能读）
#   3. 注册 systemd 服务并开机自启，授予 CAP_NET_RAW + CAP_NET_ADMIN（真网卡能力，
#      但不给整个 root：服务本身以专用非特权用户运行，只多这两项网络权限）
#   4. 打印出神枢侧要填的 NEXUS_EXEC_URL / NEXUS_EXEC_TOKEN
set -euo pipefail

SERVICE_USER="nexusnic"
INSTALL_DIR="/opt/nexus-nic-brain"
ENV_FILE="/etc/nexus-nic-brain.env"
PORT="${PORT:-8080}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行：sudo bash deploy/install.sh" >&2
  exit 1
fi

echo "==> 1/5 安装依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq tcpdump traceroute iproute2 iputils-ping curl ca-certificates
if ! command -v node >/dev/null 2>&1 || [ "$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 20 ]; then
  echo "    安装 Node 20 ..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi

echo "==> 2/5 部署程序到 $INSTALL_DIR"
install -d -m 755 "$INSTALL_DIR"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install -m 644 "$SRC_DIR/nic_runner.mjs" "$INSTALL_DIR/nic_runner.mjs"

echo "==> 3/5 建服务账号与令牌"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
if [ ! -f "$ENV_FILE" ]; then
  TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf 'TASK_TOKEN=%s\nPORT=%s\n' "$TOKEN" "$PORT" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "    已生成新令牌"
else
  echo "    沿用已有令牌（$ENV_FILE 已存在，不覆盖）"
fi

echo "==> 4/5 注册 systemd 服务"
cat > /etc/systemd/system/nexus-nic-brain.service <<EOF
[Unit]
Description=神枢网卡执行脑 (nexus nic brain)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $INSTALL_DIR/nic_runner.mjs
Restart=always
RestartSec=3
# 真网卡能力：只给这两项，不给 root 全权
AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN
CapabilityBoundingSet=CAP_NET_RAW CAP_NET_ADMIN
# 其余一律收紧
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/tmp

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now nexus-nic-brain >/dev/null
sleep 2

echo "==> 5/5 自检"
HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/health" || echo '连接失败')"
echo "    $HEALTH"
TOKEN_VALUE="$(grep '^TASK_TOKEN=' "$ENV_FILE" | cut -d= -f2)"

cat <<EOF

════════════════════════════════════════════════════════════
装好了。神枢侧填这两项即可接上（在 Cloudflare 里配 Worker 机密）：

  NEXUS_EXEC_URL    = https://你的公网地址        （见下方"怎么让神枢连上"）
  NEXUS_EXEC_TOKEN  = $TOKEN_VALUE

怎么让神枢连上（选一条）：
  A. 这台机器有公网 IP 和域名 → 用 Caddy/Nginx 反代到 127.0.0.1:$PORT 并开 HTTPS。
  B. 家里的机器 / 没有公网 IP → 用 Cloudflare Tunnel（推荐，不用开放任何端口）：
       cloudflared tunnel login
       cloudflared tunnel create nexus-nic
       cloudflared tunnel route dns nexus-nic nic.你的域名
       cloudflared tunnel run --url http://127.0.0.1:$PORT nexus-nic
     然后 NEXUS_EXEC_URL 填 https://nic.你的域名

查看状态：  systemctl status nexus-nic-brain
查看日志：  journalctl -u nexus-nic-brain -f
网卡自检：  curl -s -X POST http://127.0.0.1:$PORT/nic/probe -H "Authorization: Bearer $TOKEN_VALUE" -H 'Content-Type: application/json' -d '{}'
════════════════════════════════════════════════════════════
EOF
