FROM node:22-alpine

WORKDIR /home/node/fsk-entry

# Copy package files first
COPY entry/package*.json ./
COPY entry/web/package*.json web/

# Install dependencies
RUN npm ci
RUN npm --prefix web ci

# Copy source files (node_modules excluded by .dockerignore)
COPY entry/index.mjs ./
COPY entry/web/ web/

# Copy shared folder
COPY shared ../shared

# Build web application
RUN npm --prefix web run build

EXPOSE 9100
CMD [ "node", "index.mjs" ]
