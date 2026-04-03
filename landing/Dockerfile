# Build landing page
FROM node:22-alpine AS landing-builder

WORKDIR /home/node/fsk-landing

# Copy package files
COPY landing/package*.json ./

# Install dependencies
RUN npm ci

# Copy source files
COPY landing/src ./src
COPY landing/public ./public
COPY landing/index.html ./
COPY landing/vite.config.js ./

# Copy shared folder
COPY shared ../shared

# Build application
RUN npm run build

# Final Caddy image
FROM docker.io/library/caddy:alpine

# Copy Caddyfile
COPY landing/Caddyfile /etc/caddy/Caddyfile

# Copy landing build
COPY --from=landing-builder /home/node/fsk-landing/dist /srv/landing

COPY landing/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

EXPOSE 9000
