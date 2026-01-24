FROM node:22-alpine

WORKDIR /home/node/fsk-queue

# Copy package files first
COPY queue/package*.json ./
COPY queue/web/package*.json web/

# Install dependencies
RUN npm ci
RUN npm --prefix web ci

# Copy source files (node_modules excluded by .dockerignore)
COPY queue/index.mjs ./
COPY queue/web/ web/

# Copy shared folder
COPY shared ../shared

# Build web application
RUN npm --prefix web run build

EXPOSE 9300
CMD [ "node", "index.mjs" ]
