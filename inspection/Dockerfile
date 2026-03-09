FROM node:22-alpine

WORKDIR /home/node/fsk-inspection

# Copy package files first
COPY inspection/package*.json ./
COPY inspection/web/package*.json web/

# Install dependencies
RUN npm ci
RUN npm --prefix web ci

# Copy source files (node_modules excluded by .dockerignore)
COPY inspection/index.mjs ./
COPY inspection/web/ web/

# Copy shared folder
COPY shared ../shared

# Build web application
RUN npm --prefix web run build

EXPOSE 9600
CMD [ "node", "index.mjs" ]
