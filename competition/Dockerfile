FROM node:22-alpine AS builder
WORKDIR /build

COPY competition/package*.json ./
RUN npm ci

COPY entry/web/package*.json entry/web/
COPY queue/web/package*.json queue/web/
COPY registration/web/package*.json registration/web/
COPY inspection/web/package*.json inspection/web/
COPY traffic/web/package*.json traffic/web/
COPY score/web/package*.json score/web/
COPY documents/web/package*.json documents/web/
RUN set -e; for service in entry queue registration inspection traffic score documents; do npm --prefix "$service/web" ci --ignore-scripts; done
RUN set -e; for service in entry queue registration inspection traffic score documents; do node "$service/web/node_modules/esbuild/install.js"; done

COPY shared shared/
COPY inspection/lib inspection/lib/
COPY traffic/lib traffic/lib/
COPY entry/web entry/web/
COPY queue/web queue/web/
COPY registration/web registration/web/
COPY inspection/web inspection/web/
COPY traffic/web traffic/web/
COPY score/web score/web/
COPY documents/web documents/web/
RUN set -e; for service in entry queue registration inspection traffic score documents; do npm --prefix "$service/web" run build; done

FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY --from=builder /build/node_modules node_modules/
COPY competition/package.json package.json
COPY competition/index.mjs competition/index.mjs
COPY competition/lib competition/lib/
COPY competition/modules competition/modules/
COPY competition/scripts competition/scripts/
COPY queue/index.mjs queue/index.mjs
COPY queue/lib queue/lib/
COPY registration/index.mjs registration/index.mjs
COPY inspection/index.mjs inspection/index.mjs
COPY inspection/lib inspection/lib/
COPY traffic/index.mjs traffic/index.mjs
COPY traffic/lib traffic/lib/
COPY score/index.mjs score/index.mjs
COPY score/lib score/lib/
COPY documents/index.mjs documents/index.mjs
COPY documents/lib documents/lib/
COPY shared shared/
COPY --from=builder /build/entry/web/dist entry/web/dist/
COPY --from=builder /build/queue/web/dist queue/web/dist/
COPY --from=builder /build/registration/web/dist registration/web/dist/
COPY --from=builder /build/inspection/web/dist inspection/web/dist/
COPY --from=builder /build/traffic/web/dist traffic/web/dist/
COPY --from=builder /build/score/web/dist score/web/dist/
COPY --from=builder /build/documents/web/dist documents/web/dist/
COPY competition/entrypoint.sh /usr/local/bin/competition-entrypoint
ENV NODE_ENV=production
RUN mkdir -p data && chown -R node:node /app
EXPOSE 9200
ENTRYPOINT ["competition-entrypoint"]
CMD ["node", "competition/index.mjs"]
