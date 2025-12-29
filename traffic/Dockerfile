FROM node:22-alpine

WORKDIR /home/node/fsk-traffic

# Copy package files first
COPY package*.json ./
COPY web/package*.json web/

# Install dependencies
RUN npm ci
RUN npm --prefix web ci

# Copy source files (node_modules excluded by .dockerignore)
COPY index.mjs ./
COPY web/ web/

# Build web application
RUN npm --prefix web run build

EXPOSE 9200
CMD [ "node", "index.mjs" ]
