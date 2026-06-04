ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

RUN sed -i \
    -e 's|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' \
    -e 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' \
    /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# 再次声明 NODE_IMAGE，让两个阶段的基础镜像参数在各自 FROM 前都清晰可见。
ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV BRIDGE_CONFIG_PATH=/app/config.json

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY config.example.json ./config.example.json

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
