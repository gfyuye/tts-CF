FROM node:20-slim

WORKDIR /app

# 安装依赖（无第三方依赖，仅占位）
COPY docker/package.json ./
RUN npm install --omit=dev

# 复制 docker 目录文件
COPY docker/server.js docker/d1-json.js ./

# 复制主仓库的 worker.js（从上级目录）
COPY worker.js ./

# 数据目录
RUN mkdir -p /app/data

EXPOSE 8787

CMD ["node", "server.js"]
