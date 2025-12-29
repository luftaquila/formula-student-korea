# Build landing page
FROM node:22-alpine AS landing-builder

WORKDIR /home/node/fsk-landing

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source files
COPY . .

# Build application
RUN npm run build

# Final nginx image
FROM nginx:alpine

# Copy landing build
COPY --from=landing-builder /home/node/fsk-landing/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 9000

