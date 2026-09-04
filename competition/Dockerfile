# syntax=docker/dockerfile:1

FROM node:22-alpine AS dependencies
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN apk add --no-cache python3 make g++
RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY competition/package.json competition/package.json

COPY entry/web/package.json entry/web/package.json
COPY queue/web/package.json queue/web/package.json
COPY registration/web/package.json registration/web/package.json
COPY inspection/web/package.json inspection/web/package.json
COPY traffic/web/package.json traffic/web/package.json
COPY score/web/package.json score/web/package.json
COPY documents/web/package.json documents/web/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter ./competition \
      --filter ./entry/web \
      --filter ./queue/web \
      --filter ./registration/web \
      --filter ./inspection/web \
      --filter ./traffic/web \
      --filter ./score/web \
      --filter ./documents/web
RUN pnpm --filter ./competition deploy --prod /prod/competition

FROM dependencies AS web-base
COPY shared shared/

FROM web-base AS entry-web
COPY entry/web entry/web/
RUN pnpm --dir entry/web run build

FROM web-base AS queue-web
COPY queue/web queue/web/
RUN pnpm --dir queue/web run build

FROM web-base AS registration-web
COPY registration/web registration/web/
RUN pnpm --dir registration/web run build

FROM web-base AS inspection-web
COPY inspection/lib inspection/lib/
COPY inspection/web inspection/web/
RUN pnpm --dir inspection/web run build

FROM web-base AS traffic-web
COPY traffic/lib traffic/lib/
COPY traffic/web traffic/web/
RUN pnpm --dir traffic/web run build

FROM web-base AS score-web
COPY score/lib score/lib/
COPY score/web score/web/
RUN pnpm --dir score/web run build

FROM web-base AS documents-web
COPY documents/web documents/web/
RUN pnpm --dir documents/web run build

FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY --from=dependencies /prod/competition/node_modules node_modules/
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
COPY --from=entry-web /workspace/entry/web/dist entry/web/dist/
COPY --from=queue-web /workspace/queue/web/dist queue/web/dist/
COPY --from=registration-web /workspace/registration/web/dist registration/web/dist/
COPY --from=inspection-web /workspace/inspection/web/dist inspection/web/dist/
COPY --from=traffic-web /workspace/traffic/web/dist traffic/web/dist/
COPY --from=score-web /workspace/score/web/dist score/web/dist/
COPY --from=documents-web /workspace/documents/web/dist documents/web/dist/
COPY competition/entrypoint.sh /usr/local/bin/competition-entrypoint
ENV NODE_ENV=production
RUN mkdir -p data && chown -R node:node /app
EXPOSE 9200
ENTRYPOINT ["competition-entrypoint"]
CMD ["node", "competition/index.mjs"]
