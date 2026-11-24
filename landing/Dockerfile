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
COPY landing/site-setup.mjs landing/site-setup.mjs

# Copy shared folder
COPY shared shared

# Build application
RUN pnpm --dir landing run build

# Final Caddy image
FROM docker.io/library/caddy:alpine

# The entrypoint renders the site configuration with the shared Node modules
# before Caddy starts.
RUN apk add --no-cache nodejs

# Copy Caddyfile and the per-feature route snippets
COPY landing/Caddyfile /etc/caddy/Caddyfile
COPY landing/routes /etc/caddy/routes

# Site setup script and the shared configuration rules it applies
COPY shared/common /opt/site/shared/common
COPY landing/site-setup.mjs /opt/site/landing/site-setup.mjs
RUN echo '{"type":"module"}' > /opt/site/package.json

# Copy landing build. The entrypoint renders /srv/landing/index.html from the
# pristine copy so a restarted container renders it again.
COPY --from=landing-builder /workspace/landing/dist /srv/landing
COPY --from=landing-builder /workspace/landing/dist/index.html /opt/site/landing-index.html

COPY landing/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

EXPOSE 9000
