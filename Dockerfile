# syntax=docker/dockerfile:1

# ---------- 构建阶段 ----------
FROM node:26-alpine AS build
WORKDIR /app

# node:26 镜像里已经不带 corepack，直接装固定版本的 pnpm
RUN npm install -g pnpm@12.16.1

# 依赖层单独缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.ui.json vite.config.ts ./
COPY src ./src
RUN pnpm run build

# ---------- 运行阶段 ----------
FROM node:26-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# Node 端产物是 esbuild 打好的单文件（hono/zod 已内联），运行时不需要 node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/node.mjs"]
