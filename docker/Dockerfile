# ============ 构建阶段 ============
FROM node:20-alpine AS builder

WORKDIR /app
COPY docker/package.json ./
RUN npm install --omit=dev

# ============ 运行阶段 ============
FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY docker/package.json ./
COPY docker/server.js docker/d1-json.js ./
COPY worker.js ./

# 非 root 用户 + 数据目录
RUN mkdir -p /app/data && \
    addgroup -S app && adduser -S app -G app && \
    chown -R app:app /app

USER app

EXPOSE 8787
CMD ["node", "server.js"]
