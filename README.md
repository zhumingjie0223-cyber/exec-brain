# exec-brain — 神枢的外部执行脑

两个服务，零依赖 Node 20+ 单文件，协议完全一致（`POST /exec` + Bearer 令牌），
神枢侧配好 `NEXUS_EXEC_URL` / `NEXUS_EXEC_TOKEN` 就能接上，不用改神枢一行代码。

| 文件 | 干什么 | 什么时候用 |
|---|---|---|
| `task_runner.mjs` | 普通远程执行脑（跑命令） | 只要能跑命令就行，随便丢哪台机器/PaaS |
| `nic_runner.mjs` | **网卡执行脑**（真网卡能力） | 要抓包、原始 ICMP、建虚拟网卡——云端做不到的事 |

## 为什么需要网卡执行脑

神枢主体跑在 Cloudflare Workers + Containers 上，那套环境**只给出站请求能力**：
没有 `CAP_NET_RAW`（原始套接字/抓包）、没有 `CAP_NET_ADMIN`（建网卡/改路由）、没有 `/dev/net/tun`。
所以抓包、ping 的原始 ICMP、建虚拟网卡这些事，在云端一律做不了——这不是神枢没写，是平台不给。

网卡执行脑装在**一台真 Linux 机器**上（家里的小主机、旧笔记本、任意 VPS 都行），
把那台机器的真网卡借给神枢用。神枢照旧在云上思考，需要碰网卡时把活派过来。

## 网卡执行脑接口

全部要 Bearer 鉴权（`/health` 除外）。未配 `TASK_TOKEN` 时除 `/health` 外一律 503，绝不裸奔。

| 接口 | 作用 | 硬上限 |
|---|---|---|
| `GET /health` | 健康检查，顺带报网卡级别 | — |
| `POST /exec` | 跑命令（与神枢远程执行脑协议一致） | 60 秒 |
| `POST /nic/probe` | **如实报告本机网卡能力**（读内核 capability 位，不猜不吹） | — |
| `POST /nic/ifaces` | 列出本机网卡与地址 | — |
| `POST /nic/ping` | ICMP 探测 | 20 次 |
| `POST /nic/trace` | 路由追踪 | 20 跳 |
| `POST /nic/capture` | 抓本机网卡的包 | 20 秒 / 200 包 |
| `POST /nic/tun` | 建/删/看虚拟网卡（需 CAP_NET_ADMIN） | — |

`/nic/probe` 会把这台机器归到三档之一，如实告诉你能干到哪：

- **完整真网卡** — 可抓包 / 可建虚拟网卡 / 可原始套接字（有 NET_RAW + NET_ADMIN + `/dev/net/tun`）
- **半真网卡** — 可抓包与原始套接字，但不能建虚拟网卡或改路由
- **仅普通出站** — 连不上真网卡层，与 Cloudflare 容器同级（说明部署方式没给够权限）

## 部署（选一条）

### A. systemd（推荐，任意 Debian/Ubuntu 机器）

```bash
git clone https://github.com/zhumingjie0223-cyber/exec-brain && cd exec-brain
sudo bash deploy/install.sh
```

装完自动打印神枢侧要填的两项。服务以**专用非特权账号**运行，只额外授予
`CAP_NET_RAW` + `CAP_NET_ADMIN` 两项网络权限，不给 root 全权。

### B. Docker

```bash
cd deploy
TASK_TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n') docker compose up -d
```

关键是 `cap_add: [NET_RAW, NET_ADMIN]` + `/dev/net/tun` + `network_mode: host`——
少任何一样都拿不到真网卡（普通容器默认没有）。

### 怎么让神枢连上

- 机器有公网 IP 和域名 → Caddy/Nginx 反代到 `127.0.0.1:8080` 并开 HTTPS。
- 家里的机器 / 没有公网 IP → **Cloudflare Tunnel**（推荐，不用开放任何端口，也不用公网 IP）：

```bash
cloudflared tunnel login
cloudflared tunnel create nexus-nic
cloudflared tunnel route dns nexus-nic nic.你的域名
cloudflared tunnel run --url http://127.0.0.1:8080 nexus-nic
```

然后在 Cloudflare 给神枢 Worker 配两个机密：

```bash
cd web/nexus-do
npx wrangler secret put NEXUS_EXEC_URL     # https://nic.你的域名
npx wrangler secret put NEXUS_EXEC_TOKEN   # 安装脚本打印的令牌
```

配完神枢的执行就自动优先走这台真机（`execRemote` 里 `NEXUS_EXEC_URL` 的优先级高于内置容器），
真网卡能力立刻到位。

## 安全

- 全接口强制 Bearer 鉴权；`TASK_TOKEN` 未配则除健康检查外全部 503。
- 神枢侧的**危险命令二次确认闸在派发前生效**，本服务不绕过、不削弱。
- 网卡类操作只针对**本机自己的网络栈**，且逐项设硬上限（抓包时长/包数、ping 次数、跳数）。
- 目标主机名、网卡名、抓包过滤表达式全部走白名单校验，命令用参数数组直传不过 shell，杜绝拼接注入。

## 测试

```bash
node --test test/nic.test.mjs    # 起真服务、走真 HTTP、打真接口，15 项
```

缺 `tcpdump` / `ping` 的机器上，测试会验证「优雅报错不崩」而不是假装通过。
