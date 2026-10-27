# token-worker (Go)

将 token-worker 用 Go 重写，单二进制，无运行时依赖。用于为 TTS Worker 提供 `/get-token` 端点。

## 特点

- **单二进制**：~7MB，无 Node/Go 运行时依赖
- **低内存**：~5-10MB
- **快速启动**：~10ms
- **仅前 5 级**：只请求 `southeastasia/eastus/westeurope/westus2/eastasia`
- **单次 1s 超时**：3 次重试，最坏 3s
- **优雅关闭**：`SIGTERM` 时取消进行中请求

## 下载二进制

**不提交到 Git 仓库**，通过 GitHub Release 分发：

### 稳定版（推荐）

```
https://github.com/<user>/<repo>/releases/latest
```

或命令行：

```bash
wget https://github.com/<user>/<repo>/releases/latest/download/token-worker-linux-amd64
```

### 最新构建（滚动）

每次 push 到 `main`（修改 `go/`）自动更新：

```
https://github.com/<user>/<repo>/releases/tag/latest
```

或：

```bash
wget https://github.com/<user>/<repo>/releases/download/latest/token-worker-linux-amd64
```

### 指定版本

```bash
wget https://github.com/<user>/<repo>/releases/download/v1.0.0/token-worker-linux-amd64
```

### 平台对照

| 平台 | 文件 |
|---|---|
| Linux amd64 | `token-worker-linux-amd64` |
| Linux arm64 | `token-worker-linux-arm64` |
| macOS amd64 | `token-worker-darwin-amd64` |
| macOS arm64 | `token-worker-darwin-arm64` |
| Windows amd64 | `token-worker-windows-amd64.exe` |

### 本地编译

```bash
git clone https://github.com/<user>/<repo>.git
cd <repo>/go

CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o token-worker .
```

产物在 `go/` 目录，**不提交到 Git**（`.gitignore` 已排除）。

## 运行

```bash
API_KEY=your-token-key PORT=8788 ./token-worker
```

## 验证

```bash
# 健康检查
curl http://localhost:8788/health
# {"status":"ok","apiKey":"configured"}

# 获取 token
curl -H "X-API-Key: your-token-key" http://localhost:8788/get-token
# {"success":true,"region":"southeastasia","token":"...","priority":1,...}
```

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `API_KEY` | ✅ | — | token-worker 自己的密钥 |
| `PORT` | ❌ | `8788` | 监听端口 |

## 接口

| 路径 | 说明 |
|---|---|
| `/get-token` | 获取 token |
| `/token` | 同 `/get-token` |
| `/health` | 健康检查 |

## 响应

**成功**：

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

**失败**：

```json
{
  "success": false,
  "error": "未获取可用的token",
  "message": "无法从微软接口获取 token",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

> **注意**：`success: true` 时，`priority` 可能 > 5（3 次都拿到后 4 级 token）。调用方需自行判断 `priority` 是否可接受。

**鉴权失败**：

```json
{"success": false, "error": "认证失败"}
```
（HTTP 401）

## 部署

### 方式一：systemd（推荐）

```bash
# 1. 下载二进制
wget https://github.com/<user>/<repo>/releases/latest/download/token-worker-linux-amd64

# 2. 上传服务器
scp token-worker-linux-amd64 user@server:/tmp/token-worker

# 3. 服务器安装
sudo mkdir -p /opt/token-worker
sudo mv /tmp/token-worker /opt/token-worker/token-worker
sudo chmod +x /opt/token-worker/token-worker
sudo chown -R www-data:www-data /opt/token-worker

# 4. systemd 服务
sudo tee /etc/systemd/system/token-worker.service > /dev/null <<EOF
[Unit]
Description=Token Worker (Go)
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/token-worker
Environment=API_KEY=your-token-key
Environment=PORT=8788
ExecStart=/opt/token-worker/token-worker
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

MemoryMax=64M
CPUQuota=100%

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/token-worker

[Install]
WantedBy=multi-user.target
EOF

# 5. 启动
sudo systemctl daemon-reload
sudo systemctl enable --now token-worker
sudo systemctl status token-worker

# 6. 验证
curl http://localhost:8788/health
```

### 方式二：Docker

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go/ .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -trimpath -o /token-worker .

FROM scratch
COPY --from=builder /token-worker /token-worker
EXPOSE 8788
ENTRYPOINT ["/token-worker"]
```

```bash
docker build -t token-worker .
docker run -d --name token-worker -p 8788:8788 -e API_KEY=your-key token-worker
```

镜像约 **7MB**。

### 方式三：Nginx 反代 + HTTPS

```nginx
server {
  listen 443 ssl http2;
  server_name token.example.com;

  ssl_certificate /etc/letsencrypt/live/token.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/token.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

## 在 TTS Worker 中配置

TTS Worker 的 `REMOTETOKEN` 添加：

```
token-node https://token.example.com/get-token your-token-key
```

| 列 | 值 |
|---|---|
| `name` | `token-node`（任意，需与 TTS Worker 的 `WORKER_NODE_ID` 不同） |
| `url` | token-worker 的 `/get-token` 地址 |
| `api_key` | **等于** token-worker 的 `API_KEY` |

> `api_key` 与 TTS Worker 自身的 `API_KEY` **无关**，只需与 token-worker 的 `API_KEY` 相同。

## 开发

### 单元测试

```bash
cd go
go test -v ./...
```

### 本地编译

见「下载二进制 → 本地编译」。

## 版本发布

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions 自动：
1. 运行测试；
2. 编译 5 个平台；
3. 创建 GitHub Release，附带所有二进制。

日常 push 到 `main`（修改 `go/`）会自动更新 `latest` 滚动 Release。

## 资源占用

| 项 | 值 |
|---|---|
| 二进制大小 | ~7MB（`-ldflags="-s -w"`） |
| 空闲内存 | ~5-10MB |
| 启动时间 | ~10ms |
| 运行时依赖 | 无 |

## License

GNU Affero General Public License v3.0

本项目采用 [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html) 许可。任何修改后的版本若通过网络提供服务，必须以相同许可开源。

详见 [LICENSE](./LICENSE)。
