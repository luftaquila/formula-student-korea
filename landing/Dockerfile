# syntax=docker/dockerfile:1

# Build landing page
FROM node:22-alpine AS landing-builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /workspace

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY landing/package.json landing/package.json

# Install dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter ./landing

# Copy source files
COPY landing/src landing/src
COPY landing/public landing/public
COPY landing/index.html landing/index.html
COPY landing/vite.config.js landing/vite.config.js

# Copy shared folder
COPY shared shared

# Build application
RUN pnpm --dir landing run build

# Final Caddy image
FROM docker.io/library/caddy:alpine

# Copy Caddyfile
COPY landing/Caddyfile /etc/caddy/Caddyfile

# Copy landing build
COPY --from=landing-builder /workspace/landing/dist /srv/landing

COPY landing/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

EXPOSE 9000
