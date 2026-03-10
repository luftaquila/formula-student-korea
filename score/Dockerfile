FROM node:22-alpine

WORKDIR /home/node/fsk-score

# Copy package files first
COPY score/package*.json ./
COPY score/web/package*.json web/

# Install dependencies
RUN npm ci
RUN npm --prefix web ci

# Copy source files (node_modules excluded by .dockerignore)
COPY score/index.mjs ./
COPY score/web/ web/

# Copy shared folder
COPY shared ../shared

# Build web application
RUN npm --prefix web run build

EXPOSE 9700
CMD [ "node", "index.mjs" ]
