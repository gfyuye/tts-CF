# Microsoft TTS Worker

本项目灵感来源于“https://github.com/zuoban/tts”项目中的worker.js，借用了其中的tts试听页面，对其他部分进行了完全的重构。
本项目基于 Cloudflare Workers 的 Microsoft TTS 代理服务，支持多节点 token 池共享、SSML 注入防护、节点间 HMAC 鉴权、D1 持久化缓存。

## 特性

- 🎙️ **多语音/多风格**：从微软官方语音列表动态生成端点表，支持中文全系列语音
- 🔗 **多节点 token 池共享**：节点间通过 `/get-token` 互调，HMAC 签名 + 时间戳 + 白名单 + 限流四重鉴权
- 🛡️ **安全防护**：SSML 注入双重防御、节点鉴权、API Key 恒定时间比较、回环阻断
- 💾 **D1 持久化**：端点表、token 缓存、语音列表三张表，原子批量写入
- 🔄 **自动刷新**：`scheduled` 定时刷新端点表，分批并发降低 CPU 峰值
- 🤖 **OpenAI 兼容**：`/v1/audio/speech` 支持 OpenAI TTS 客户端
- 🎨 **Web 界面**：内置在线 TTS 试听页
- 🧩 **独立 token-worker**：附带可插入任意 Worker 的轻量 token 获取模块
- 🐳 **Docker 自托管**：附带 Node.js + JSON D1 模拟的 Docker 部署方案（可选）

## 路由

| 路径 | 方法 | 说明 |
|---|---|---|
| `/` | GET | Web 试听界面 |
| `/tts`、`/api/v1/tts` | GET/POST | TTS 合成 |
| `/voices`、`/api/v1/voices` | GET | 语音列表 |
| `/endpoints` | GET | 端点表状态 |
| `/health` | GET | 健康检查 |
| `/v1/audio/speech`、`/audio/speech` | POST | OpenAI 兼容 TTS |
| `/get-token` | GET | 节点间 token 共享（需 HMAC 签名） |
| `/reader.json` | GET | 阅读 App 导入配置 |
| `/reader-post.json` | GET | 阅读 App 导入配置（POST） |
| `/ifreetime.json` | GET | 爱阅记导入配置 |

## 文件结构

```
.
├── README.md
├── worker.js                 # 主 TTS Worker
├── token-worker.js           # 独立 token 获取模块（可选）
├── wrangler.toml
├── schema.sql
├── package.json
├── .gitignore
├── LICENSE                   # AGPL-3.0
├── .github/
│   └── workflows/
│       └── deploy.yml
└── docker/                   # Docker 自托管（可选，与主代码隔离）
    ├── README.md
    ├── Dockerfile
    ├── docker-compose.yml
    ├── .dockerignore
    ├── .env.example
    ├── package.json
    ├── server.js
    ├── d1-json.js
    └── data/
        └── .gitkeep
```

---

## 部署方式

提供三种部署方式，任选其一。

| 方式 | 适合 | 依赖 Cloudflare |
|---|---|---|
| **方式一：GitHub Actions** | 团队/多环境/CI 标准化 | ✅ |
| **方式二：Dashboard 连接 Git** | 个人快速上手 | ✅ |
| **方式三：Docker 自托管** | 本地开发/测试/单实例 | ❌ |

### 方式一：GitHub Actions 一键部署（推荐）

全自动：创建 D1、初始化表结构、设置 Secret、部署 Worker。首次配置 GitHub Secrets/Variables 后，push 即全自动。

#### 步骤 1：Fork / Clone 仓库

```bash
git clone https://github.com/<your-name>/<repo>.git
cd <repo>
```

#### 步骤 2：创建 Cloudflare API Token

1. 访问 [Cloudflare Dashboard → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. 使用模板 **Edit Cloudflare Workers**
3. 额外添加权限：**Account → D1 → Edit**
4. 复制 Token

同时获取 **Account ID**（Dashboard 右侧栏或 Workers 页面 URL 中）。

#### 步骤 3：配置 GitHub Secrets 和 Variables

进入 GitHub 仓库 → **Settings → Secrets and variables → Actions**：

**Secrets**（敏感信息，日志不可见）：

| Name | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 步骤 2 复制的 Token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `API_KEY` | `openssl rand -hex 32` 生成 |
| `WORKER_SHARED_SECRET` | `openssl rand -hex 32` 生成 |

**Variables**（明文，日志可见）：

| Name | 示例 |
|---|---|
| `WORKER_NODE_ID` | `node-a` |
| `REMOTETOKEN` | `node-b https://worker-b.example.workers.dev <B的API_KEY>`（单节点留空） |

#### 步骤 4：推送到 main

```bash
git push origin main
```

GitHub Actions 自动执行：

1. ✅ 检查配置
2. 📦 查询/创建 D1 数据库 `tts-db`
3. 📝 注入 `database_id` 到 `wrangler.toml`
4. 🗄️ 初始化表结构
5. 🔐 设置 Worker Secrets
6. 🚀 部署 Worker

部署完成后访问 `https://tts-worker.<subdomain>.workers.dev`。

---

### 方式二：Cloudflare Dashboard 连接 Git

在 Cloudflare Dashboard 中连接 GitHub 仓库，push 自动部署。**需一次性手动配置 D1 和 Secret**。

#### 步骤 1：创建 D1 数据库

Cloudflare Dashboard → **Workers & Pages → D1** → Create database → 名称 `tts-db`。

复制 `database_id`，填入仓库 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "tts-db"
database_id = "你的database_id"
```

提交并推送。

#### 步骤 2：初始化表结构

本地执行（需 `wrangler login`）：

```bash
npm install
npx wrangler d1 execute tts-db --remote --file=schema.sql
```

#### 步骤 3：连接 Git

Cloudflare Dashboard → **Workers & Pages → Create → Connect to Git**：

- 选择你的仓库
- Build command：留空
- Deploy command：`npx wrangler deploy`

#### 步骤 4：设置 Secrets

部署后，Worker → **Settings → Variables and Secrets** → Add：

| Name | Type | 值 |
|---|---|---|
| `API_KEY` | Secret | `openssl rand -hex 32` |
| `WORKER_SHARED_SECRET` | Secret | `openssl rand -hex 32` |

同时确认 `[vars]` 中的 `WORKER_NODE_ID`、`REMOTETOKEN` 正确。

#### 步骤 5：重新部署

Dashboard 中 Trigger deploy，或 push 一次提交。

---

### 方式三：Docker 自托管（可选，不依赖 Cloudflare）

用 Node.js + JSON 模拟 D1 运行 `worker.js`，**完全脱离 Cloudflare**，适合本地开发、测试、单实例自托管。

详见 [`docker/README.md`](./docker/README.md)。

```bash
cd docker
cp .env.example .env   # 编辑填入 API_KEY / WORKER_SHARED_SECRET
docker compose up -d --build
curl http://localhost:8787/health
```

**局限**：

- 单实例，JSON 文件不支持多容器并发写
- `scheduled` 用 `setInterval` 模拟（每 6 小时）
- 无 Cloudflare 边缘信息（`request.cf.colo = 'docker'`）
- 仅支持 `worker.js` 用到的 SQL 子集

**适用场景**：本地开发、测试、家庭服务器、单实例内网服务。

**生产环境推荐方式一或方式二**（Cloudflare 部署，D1 托管，自动扩展）。

---

### 三种部署方式对比

| 项 | 方式一（GitHub Actions） | 方式二（Dashboard 连接 Git） | 方式三（Docker） |
|---|---|---|---|
| D1 自动创建 | ✅ | ❌ 需手动创建 | ❌ JSON 模拟 |
| D1 schema 自动初始化 | ✅ | ❌ 需手动执行 | ✅ JSON 自动 |
| Secret 自动设置 | ✅ | ❌ 需手动在 Dashboard | ✅ 环境变量 |
| 依赖 Cloudflare | ✅ | ✅ | ❌ |
| 多实例 | ✅ | ✅ | ❌ 单实例 |
| 边缘加速 | ✅ | ✅ | ❌ |
| 定时任务 | ✅ `scheduled` | ✅ `scheduled` | ⚠️ `setInterval` 模拟 |
| GitHub 配置量 | Secrets 4 + Variables 2 | 无 | 无 |
| 适合 | 团队/CI | 个人快速 | 本地/测试/单实例 |

---

## 环境变量

### 明文变量（`wrangler.toml` 的 `[vars]`）

| 变量 | 必填 | 说明 | 示例 |
|---|---|---|---|
| `WORKER_NODE_ID` | ✅ | 本节点唯一标识，多节点必须不同 | `node-a` |
| `REMOTETOKEN` | ✅ | 远程节点列表，每行 `name url api_key`，`name` 为对方 `WORKER_NODE_ID` | `node-b https://worker-b.workers.dev sk-bbb` |

> `REMOTETOKEN` **必须每行一条**。若环境变量平台吞换行，代码会自动按 `https://` 边界拆分并告警，但建议修正配置。

### Secret

| 变量 | 必填 | 说明 |
|---|---|---|
| `API_KEY` | ✅ | 对外 API Key，多节点必须相同 |
| `WORKER_SHARED_SECRET` | ✅ | 节点间 HMAC 签名密钥，多节点必须相同，≥32 字节随机串 |

### 生成随机密钥

```bash
openssl rand -hex 32
```

### Docker 环境变量

方式三使用 `.env` 文件（见 `docker/.env.example`），变量同上。

---

## 多节点部署

两个 Worker 共享 token 池，需保证：

| 变量 | 节点 A | 节点 B |
|---|---|---|
| `WORKER_NODE_ID` | `node-a` | `node-b` |
| `API_KEY` | **相同** | **相同** |
| `WORKER_SHARED_SECRET` | **相同** | **相同** |
| `REMOTETOKEN` | `node-b https://worker-b.workers.dev <B的API_KEY>` | `node-a https://worker-a.workers.dev <A的API_KEY>` |

两节点共用同一个 D1 数据库（`database_id` 相同）。

部署方式：

- **方式一**：两个仓库（或同仓库两 branch），各自配置 GitHub Variables 的 `WORKER_NODE_ID`、`REMOTETOKEN`，`API_KEY`/`WORKER_SHARED_SECRET` 相同。
- **方式二**：两个 Worker 连接同一仓库不同分支，或手动 deploy 两次改 `WORKER_NODE_ID`。
- **方式三**：启动两个 Docker 容器，各自的 `.env` 配置 `WORKER_NODE_ID` 和 `REMOTETOKEN`，**不能共用 `data/db.json`**（单实例限制）。

---

## 使用示例

### cURL

```bash
curl -X POST https://<worker>.workers.dev/tts \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "your-api-key",
    "text": "你好，世界",
    "voice": "zh-CN-XiaoxiaoNeural",
    "style": "cheerful",
    "rate": 0,
    "pitch": 0
  }' --output audio.mp3
```

### OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<worker>.workers.dev/v1",
    api_key="your-api-key"
)

response = client.audio.speech.create(
    model="tts-1",
    voice="alloy",
    input="Hello, world"
)
response.stream_to_file("output.mp3")
```

---

## 数据库表结构

见 `schema.sql`，包含三张表：

- `endpoint_table`：区域端点表（region, priority, voices_data）
- `token_cache`：token 缓存（region, token, expiry, priority）
- `voice_list`：合并语音列表（voice_name, voice_data）

Docker 方式下由 `docker/d1-json.js` 用 JSON 文件模拟，结构一致。

---

## 定时刷新

Cloudflare 方式在 `wrangler.toml` 中配置：

```toml
[triggers]
crons = ["0 */6 * * *"]  # 每 6 小时
```

Docker 方式由 `docker/server.js` 的 `setInterval` 模拟，同样每 6 小时。

`scheduled` 会重新拉取微软语音列表并写入存储。

---

## 本地开发

### Cloudflare 方式

```bash
# 安装依赖
npm install

# 本地 D1 初始化
npx wrangler d1 execute tts-db --local --file=schema.sql

# 启动本地开发服务器
npm run dev

# 查看远程日志
npm run tail
```

### Docker 方式

```bash
cd docker
cp .env.example .env
docker compose up -d --build
docker compose logs -f
```

---

## 架构说明

```
┌─────────────┐         /get-token          ┌─────────────┐
│  Worker A   │ ◄─────────────────────────► │  Worker B   │
│  node-a     │   HMAC + TS + NodeId        │  node-b     │
└──────┬──────┘                             └──────┬──────┘
       │                                           │
       └──────────────┬────────────────────────────┘
                      ▼
              ┌───────────────┐
              │  D1 Database  │
              │  共享 token 池 │
              └───────────────┘
```

- 每个 Worker 维护内存 token 缓存
- 本地无可用 token 时，通过 `/get-token` 向对方节点请求
- 对方节点返回 token，写入本地缓存和 D1
- 回环检测：A 调 B 后，B 记录"A 刚调过我"，B 反向调 A 时跳过

### Token 调用逻辑

```
/tts ──► getVoice ──► getBestToken ──► refreshToken ──► getDynamicToken（直连微软）
                                              │
                                              └─► getTokenFromRemoteService（远程节点）
```

- `getBestToken` 是所有路径获取 token 的唯一入口
- 缓存命中且未过期 → 直接返回
- 缓存命中但即将过期（< 5 分钟）→ 返回旧 token + 后台刷新
- 缓存未命中 → `ensureRefresh` 单飞刷新
- `refreshToken` 阶段 1 直连微软，阶段 2 远程节点
- **无论本地直连还是远程，匹配 `voiceName` + `style` 成功后均写入 `tokenCache` + D1**，供后续复用

---

## 附：token-worker 模块（独立 token 获取）

仓库包含 `token-worker.js`，是一个**完全独立、自包含**的 token 获取模块，可插入到任意 Cloudflare Worker 中，让该 Worker 也提供 `/get-token` 端点，供其他 TTS Worker 获取 token。

### 适用场景

- 你有一个非 TTS 的 Worker（如 API 网关、工具服务），希望它也能为 TTS Worker 提供 token
- 你希望多个 TTS Worker 共享一个"专职 token 节点"
- 你不想在每个 TTS Worker 里都实现完整的微软 token 拉取逻辑

### 设计要点

| 项 | 说明 |
|---|---|
| **仅前 5 级** | 只请求 `southeastasia/eastus/westeurope/westus2/eastasia`，后 4 级不请求 |
| **不引入节点鉴权** | 无 `X-Node-Id` / `X-Auth` / `X-TS`，仅 `API_KEY` 鉴权，适合非 TTS Worker |
| **恒定时间比较** | API Key 用 `tokenWorkerTimingSafeEqual`，防时序侧信道 |
| **未配置 API Key 拒绝** | 与主 `worker.js` 行为一致 |
| **CORS 支持** | 保留 `Access-Control-Allow-*`，支持浏览器跨域 |
| **3 次重试** | 前 5 级优先，3 次都失败返回最后 token |

> **为什么只保留前 5 级？**
> 主 `worker.js` 若只拿到后 4 级（`westus/centralindia/northeurope/japaneast`），说明前 5 级当前不可用。此时向远方 `/get-token` 获取，远方同样只能拿后 4 级，**没有增量价值**，反而增加延迟和调用。因此 `token-worker.js` 专注返回前 5 级高质量 token。

### 使用步骤

#### 步骤 1：复制模块

将 `token-worker.js` 的**全部内容**粘贴到目标 Worker 的 `worker.js` 末尾（或单独文件后 import）。

#### 步骤 2：在 `fetch` 入口插入路由

```js
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;

    // 插入点：/get-token 或 /token
    if (path === '/get-token' || path === '/token') {
      return await handleGetToken(request, env);
    }

    // 其他业务逻辑...
    return new Response('Hello');
  }
};

// ============================================================
// token-worker模块开始
// ============================================================
// ...（粘贴 token-worker.js 全部内容）...
// ============================================================
// token-worker模块结束
// ============================================================
```

#### 步骤 3：配置 API Key

```bash
npx wrangler secret put API_KEY
```

或在 `wrangler.toml` 中：

```toml
[vars]
API_KEY = "token-secret-abc"
```

> `API_KEY` 是 token-worker **自己的**密钥，用于校验 TTS Worker 调用 `/get-token` 时携带的 `X-API-Key`。
> TTS Worker 的 `REMOTETOKEN` 中对应行的 `api_key` 必须与此值相同。
> **与 TTS Worker 自身的 `API_KEY`（对外 `/tts` 用）无关**，可以是不同值。

### 与主 `worker.js` 的关系

```
┌──────────────────┐         /get-token          ┌──────────────────┐
│  TTS Worker      │ ◄─────────────────────────► │  token-worker    │
│  (worker.js)     │   X-API-Key                 │  (token-worker.js)│
│  9 区域 + 缓存   │                             │  仅前 5 级        │
└──────────────────┘                             └──────────────────┘
```

- **TTS Worker**：完整的 9 区域 token 池、缓存、远程互调
- **token-worker**：轻量级，仅提供前 5 级 token 获取，供 TTS Worker 调用

### 接口

**请求**：

```http
GET /get-token
X-API-Key: your-api-key
```

或：

```http
GET /get-token?api_key=your-api-key
```

**响应（成功）**：

```json
{
  "success": true,
  "region": "southeastasia",
  "token": "eyJ...",
  "expiry": 1700000000000,
  "priority": 1,
  "remainingMinutes": 18,
  "remainingSeconds": 30
}
```

**响应（失败）**：

```json
{
  "success": false,
  "error": "未获取可用的token",
  "message": "无法从微软接口获取 token",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

**响应（鉴权失败）**：

```json
{
  "success": false,
  "error": "认证失败"
}
```
（HTTP 401）

### 在 TTS Worker 中配置

在 TTS Worker 的 `REMOTETOKEN` 中添加 token-worker 节点：

```
token-node https://your-token-worker.workers.dev/get-token token-secret-abc
```

| 列 | 值 | 说明 |
|---|---|---|
| `name` | `token-node` | 任意标识，需与 TTS Worker 的 `WORKER_NODE_ID` 不同（避免回环误判） |
| `url` | `https://your-token-worker.workers.dev/get-token` | token-worker 的 `/get-token` 完整地址 |
| `api_key` | `token-secret-abc` | **等于** token-worker 的 `env.API_KEY` |

> ⚠️ **注意**：
> - 该行的 `api_key` 必须与 token-worker 的 `API_KEY` 相同；
> - 它与 TTS Worker 自身的 `API_KEY`（对外 `/tts` 用）**无关**，可以是不同值；
> - token-worker 不参与 HMAC 鉴权，TTS Worker 的 `getTokenFromRemoteService` 会发送 `X-Node-Id`/`X-Auth`/`X-TS`，但 token-worker 忽略这些头，只校验 `X-API-Key`。**两者兼容**。

### 与主 `worker.js` 的差异对照

| 项 | `worker.js` | `token-worker.js` |
|---|---|---|
| 区域数 | 9 | **5（仅前 5 级）** |
| 鉴权 | `X-Node-Id` 白名单 + `X-Auth` HMAC + `X-TS` + `X-API-Key` + 限流 | **仅 `X-API-Key`** |
| 缓存 | 内存 + D1 | **无**（每次直接拉微软） |
| 回环阻断 | 有 | **无**（无远程互调） |
| D1 依赖 | 有 | **无** |
| CORS | 无 | **有** |
| 定时刷新 | 有（`scheduled`） | **无** |

### 验证

```bash
# 正确 API Key（token-worker 自己的 key）
curl -H "X-API-Key: token-secret-abc" https://your-token-worker.workers.dev/get-token

# 预期
# {"success":true,"region":"southeastasia","token":"...","priority":1,...}
```

```bash
# 错误 API Key
curl -H "X-API-Key: wrong" https://your-token-worker.workers.dev/get-token

# 预期
# HTTP 401 {"success":false,"error":"认证失败"}
```

### 注意事项

1. **不要**在 token-worker 中配置 `WORKER_NODE_ID`/`WORKER_SHARED_SECRET`（它不使用）
2. **不要**把 token-worker 加入自身 `REMOTETOKEN`（避免自调用）
3. token-worker 的 `API_KEY` 与 TTS Worker 自身 `API_KEY` **无关**；它只需与 TTS Worker `REMOTETOKEN` 中对应行的 `api_key` 字段相同
4. token-worker 无缓存，高频调用会频繁拉微软，建议 TTS Worker 侧做好缓存（主 `worker.js` 已实现）

---

## 安全说明

- `API_KEY`、`WORKER_SHARED_SECRET` 用 Secret 存储，不入仓库
- `/get-token` 四重鉴权：`X-Node-Id` 白名单 + `X-Auth` HMAC + `X-TS` 时间窗 + `X-API-Key`
- SSML 注入防护：voice/style 白名单 + 正则格式校验 + 内部断言
- 节点限流：每节点 30 次/分钟
- 回环阻断：3 分钟
- Docker 方式：`docker/.env` 不入库，`docker/data/db.json` 含 token 缓存，注意文件权限

---

## 常见问题

**Q：方式一 D1 已存在会重复创建吗？**
A：不会。Workflow 先 `wrangler d1 list --json` 查询，存在则复用 `uuid`，不存在才创建。

**Q：`REMOTETOKEN` 多行如何放 GitHub Variables？**
A：直接粘贴多行字符串，GitHub Variables 支持换行。若被吞换行，代码会自动按 `https://` 边界拆分并告警。

**Q：多节点如何用方式一部署？**
A：每个节点一个仓库 fork（或同仓库不同 branch），各自配置 `WORKER_NODE_ID` 和 `REMOTETOKEN`，`API_KEY`/`WORKER_SHARED_SECRET` 相同，共用同一 D1。

**Q：Secret 能否用 GitHub Variables 代替？**
A：可以，但 Variables 在 GitHub 日志/Settings 中明文可见。`API_KEY`/`WORKER_SHARED_SECRET` 必须用 Secrets。

**Q：方式二能否自动创建 D1？**
A：不能。Dashboard 的 Git 集成不支持构建时创建 D1，需手动创建后填 `database_id`。

**Q：token-worker 能否独立部署？**
A：可以。它本身就是完整的 Worker 代码，单独 deploy 后即可作为独立的 token 服务节点，供 TTS Worker 调用。

**Q：token-worker 和 TTS Worker 必须共用 D1 吗？**
A：不需要。token-worker 无 D1 依赖，完全无状态。

**Q：token-worker 的 `API_KEY` 必须与 TTS Worker 的 `API_KEY` 相同吗？**
A：不需要。token-worker 的 `API_KEY` 只用于校验 TTS Worker 调用 `/get-token` 时携带的 `X-API-Key`。TTS Worker 在 `REMOTETOKEN` 中对应行填入这个 key 即可。它与 TTS Worker 自身对外 `/tts` 用的 `API_KEY` 无关，可以是不同值。

**Q：Docker 方式能否连接远程 D1？**
A：不能。Docker 方式用 JSON 文件模拟 D1，完全本地。若需远程 D1，只能部署到 Cloudflare。

**Q：Docker 方式能否多实例？**
A：不能。JSON 文件不支持多容器并发写，只能单实例。多实例请用 Cloudflare 部署。

**Q：Docker 方式的数据存在哪？**
A：`docker/data/db.json`，挂载到宿主机，重启不丢。已在 `.gitignore` 排除，不入库。

**Q：Docker 方式的 `scheduled` 如何触发？**
A：`docker/server.js` 用 `setInterval` 每 6 小时调用一次 `worker.scheduled`，模拟 Cloudflare 的 cron。

---

## License

GNU Affero General Public License v3.0

本项目采用 [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html) 许可。任何修改后的版本若通过网络提供服务，必须以相同许可开源。

详见 [LICENSE](./LICENSE)。
