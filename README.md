# exec-brain（已封存 · 2026-08-17）

> **本仓已弃用封存（权哥拍板）**：服务器执行脑路线取消，不再部署、不再维护。
> 神枢的执行能力改走**内置 CF 容器执行脑**（`Black-God/web/nexus-do/wrangler.jsonc`
> 里的 `ExecContainer`，随主部署自动上线，无需自备服务器），
> GitHub Actions 通道（`exec-shell.yml`）作为兜底。
> 神枢核心 `execRemote` 的外部执行脑接口**保留未删**——若未来重启服务器路线，
> 配上 `NEXUS_EXEC_URL`/`NEXUS_EXEC_TOKEN` 即可复活，本仓代码仍可直接用。

以下为原始文档（存档参考）：

---

神枢（nexus-do）的外部执行脑。零依赖 Node 20+ 单文件服务。

## 接口

- `GET /health` → `{"ok":true}`（不鉴权，健康检查）
- `POST /exec` → 鉴权 `Authorization: Bearer $TASK_TOKEN`
  - body: `{"cmd": "shell命令", "timeout": 秒（≤60，默认30）}`
  - 返回: `{"ok", "code", "stdout"(≤8000), "stderr"(≤2000), "error"}`

## 部署

Render 蓝图一键部署（render.yaml 已配好，TASK_TOKEN 自动生成）。
本地跑：`TASK_TOKEN=xxx node task_runner.mjs`
