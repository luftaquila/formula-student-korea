FROM node:22-alpine

WORKDIR /home/node/fsk-traffic

# Copy package files first
COPY traffic/package*.json ./
COPY traffic/web/package*.json web/

# Install dependencies
RUN npm ci
RUN npm --prefix web ci

# Copy source files (node_modules excluded by .dockerignore)
COPY traffic/index.mjs ./
COPY traffic/web/ web/

# Copy shared folder
COPY shared ../shared

# Build web application
RUN npm --prefix web run build

EXPOSE 9200
CMD [ "node", "index.mjs" ]
