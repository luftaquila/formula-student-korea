FROM node:22-alpine

WORKDIR /home/node/fsk-auth

# Copy package files first
COPY auth/package*.json ./
COPY auth/web/package*.json web/

# Install dependencies
RUN npm ci
RUN npm --prefix web ci

# Copy source files (node_modules excluded by .dockerignore)
COPY auth/index.mjs ./
COPY auth/web/ web/

# Copy shared folder
COPY shared ../shared

# Build web application
RUN npm --prefix web run build

EXPOSE 9800
CMD [ "node", "index.mjs" ]
