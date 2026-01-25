FROM node:22-alpine

WORKDIR /home/node/fsk-scoreboard
COPY scoreboard/package*.json ./

RUN npm ci
COPY scoreboard/ .
COPY shared ../shared
RUN npm run build

RUN npm install -g serve

EXPOSE 9500
CMD [ "serve", "-s", "dist", "-l", "9500" ]
