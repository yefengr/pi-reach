# syntax=docker/dockerfile:1
# 从仓库根构建：docker build -f pwa/Dockerfile .
FROM node:24.20.0-alpine AS deps

RUN apk add --no-cache libc6-compat && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY pwa/package.json ./pwa/package.json
COPY pi-extension/package.json ./pi-extension/package.json
COPY packages/protocol/ ./packages/protocol/
RUN pnpm --filter pwa... install --frozen-lockfile

FROM node:24.20.0-alpine AS builder

RUN apk add --no-cache libc6-compat && corepack enable
WORKDIR /app
COPY --from=deps /app/ ./
COPY pwa/ ./pwa/
COPY pi-extension/install.sh ./pi-extension/install.sh
RUN pnpm --filter pwa build

FROM nginxinc/nginx-unprivileged:1.28-alpine AS runner

USER root
RUN apk add --no-cache curl && \
    rm -f /usr/share/nginx/html/index.html /usr/share/nginx/html/50x.html
USER nginx

ENV PORT=3000

COPY --from=builder --chown=nginx:nginx /app/pwa/dist/ /usr/share/nginx/html/
COPY --chown=nginx:nginx pwa/nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:${PORT}/ || exit 1
