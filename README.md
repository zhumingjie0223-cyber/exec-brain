# exec-brain

神枢（nexus-do）的外部执行脑。零依赖 Node 20+ 单文件服务。

## 接口

- `GET /health` → `{"ok":true}`（不鉴权，健康检查）
- `POST /exec` → 鉴权 `Authorization: Bearer $TASK_TOKEN`
  - body: `{"cmd": "shell命令", "timeout": 秒（≤60，默认30）}`
  - 返回: `{"ok", "code", "stdout"(≤8000), "stderr"(≤2000), "error"}`

## 部署

Render 蓝图一键部署（render.yaml 已配好，TASK_TOKEN 自动生成）。
本地跑：`TASK_TOKEN=xxx node task_runner.mjs`
