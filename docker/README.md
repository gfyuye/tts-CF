# Docker 部署（自托管）

将主仓库的 `worker.js` 通过 Node.js + JSON 模拟 D1 运行在 Docker 中，**不依赖 Cloudflare**。

> ⚠️ 仅适合本地开发、测试、单实例自托管。生产环境建议部署到 Cloudflare（见主 README）。

## 文件说明

| 文件 | 说明 |
|---|---|
| `Dockerfile` | 镜像构建 |
| `docker-compose.yml` | 编排 |
| `server.js` | Node HTTP 服务器，加载 `../worker.js` |
| `d1-json.js` | D1 JSON 模拟 |
| `data/db.json` | 数据存储（运行时生成） |

## 快速开始

```bash
cd docker

# 复制环境变量模板
cp .env.example .env
# 编辑 .env，填入 API_KEY / WORKER_SHARED_SECRET

# 构建并启动
docker compose up -d --build

# 看日志（首次会拉微软端点表）
docker compose logs -f

# 验证
curl http://localhost:8787/health
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `API_KEY` | ✅ | 对外 API Key |
| `WORKER_SHARED_SECRET` | ✅ | 节点间 HMAC 密钥 |
| `WORKER_NODE_ID` | ✅ | 节点标识，默认 `node-a` |
| `REMOTETOKEN` | ❌ | 远程节点列表，单节点留空 |

## 数据持久化

`data/db.json` 挂载到宿主机 `docker/data/`，重启不丢。首次启动自动创建空库。

## 局限

- **单实例**：JSON 文件不支持多容器并发写
- **SQL 子集**：只支持 `worker.js` 用到的 SQL 模式
- **`scheduled` 模拟**：`setInterval` 每 6 小时触发
- **无 Cloudflare 边缘**：`request.cf.colo = 'docker'`

## 与 Cloudflare 部署的差异

| 项 | Cloudflare | Docker（JSON D1） |
|---|---|---|
| 存储 | D1（SQLite 托管） | JSON 文件 |
| 并发 | 多 isolate | 单进程 |
| 扩展 | 水平扩展 | 单实例 |
| 定时任务 | `scheduled` 触发器 | `setInterval` |
| Secret | `wrangler secret` | 环境变量 |
