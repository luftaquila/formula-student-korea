# syntax=docker/dockerfile:1

FROM node:22-alpine AS dependencies
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN apk add --no-cache python3 make g++
RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY competition/package.json competition/package.json

COPY competition/modules/teams/web/package.json competition/modules/teams/web/package.json
COPY competition/modules/queue/web/package.json competition/modules/queue/web/package.json
COPY competition/modules/registration/web/package.json competition/modules/registration/web/package.json
COPY competition/modules/inspection/web/package.json competition/modules/inspection/web/package.json
COPY competition/modules/traffic/web/package.json competition/modules/traffic/web/package.json
COPY competition/modules/score/web/package.json competition/modules/score/web/package.json
COPY competition/modules/documents/web/package.json competition/modules/documents/web/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter ./competition \
      --filter ./competition/modules/teams/web \
      --filter ./competition/modules/queue/web \
      --filter ./competition/modules/registration/web \
      --filter ./competition/modules/inspection/web \
      --filter ./competition/modules/traffic/web \
      --filter ./competition/modules/score/web \
      --filter ./competition/modules/documents/web
RUN pnpm --filter ./competition deploy --prod /prod/competition

FROM dependencies AS web-base
COPY shared shared/

FROM web-base AS entry-web
COPY competition/modules/teams/web competition/modules/teams/web/
RUN pnpm --dir competition/modules/teams/web run build

FROM web-base AS queue-web
COPY competition/modules/queue/web competition/modules/queue/web/
RUN pnpm --dir competition/modules/queue/web run build

FROM web-base AS registration-web
COPY competition/modules/registration/web competition/modules/registration/web/
RUN pnpm --dir competition/modules/registration/web run build

FROM web-base AS inspection-web
COPY competition/modules/inspection/lib competition/modules/inspection/lib/
COPY competition/modules/inspection/web competition/modules/inspection/web/
RUN pnpm --dir competition/modules/inspection/web run build

FROM web-base AS traffic-web
COPY competition/modules/traffic/lib competition/modules/traffic/lib/
COPY competition/modules/traffic/web competition/modules/traffic/web/
RUN pnpm --dir competition/modules/traffic/web run build

FROM web-base AS score-web
COPY competition/modules/score/lib competition/modules/score/lib/
COPY competition/modules/score/web competition/modules/score/web/
RUN pnpm --dir competition/modules/score/web run build

FROM web-base AS documents-web
COPY competition/modules/documents/web competition/modules/documents/web/
RUN pnpm --dir competition/modules/documents/web run build

FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY --from=dependencies /prod/competition/node_modules node_modules/
COPY competition/package.json package.json
COPY competition/index.mjs competition/index.mjs
COPY competition/lib competition/lib/
COPY competition/ui-modules.json competition/ui-modules.json
COPY competition/modules/teams/index.mjs competition/modules/teams/index.mjs
COPY competition/modules/teams/server competition/modules/teams/server/
COPY competition/modules/queue/index.mjs competition/modules/queue/index.mjs
COPY competition/modules/queue/server competition/modules/queue/server/
COPY competition/modules/queue/lib competition/modules/queue/lib/
COPY competition/modules/registration/index.mjs competition/modules/registration/index.mjs
COPY competition/modules/registration/server competition/modules/registration/server/
COPY competition/modules/inspection/index.mjs competition/modules/inspection/index.mjs
COPY competition/modules/inspection/server competition/modules/inspection/server/
COPY competition/modules/inspection/lib competition/modules/inspection/lib/
COPY competition/modules/traffic/index.mjs competition/modules/traffic/index.mjs
COPY competition/modules/traffic/server competition/modules/traffic/server/
COPY competition/modules/traffic/lib competition/modules/traffic/lib/
COPY competition/modules/score/index.mjs competition/modules/score/index.mjs
COPY competition/modules/score/server competition/modules/score/server/
COPY competition/modules/score/lib competition/modules/score/lib/
COPY competition/modules/documents/index.mjs competition/modules/documents/index.mjs
COPY competition/modules/documents/server competition/modules/documents/server/
COPY competition/modules/documents/lib competition/modules/documents/lib/
COPY competition/scripts competition/scripts/
COPY shared shared/
COPY --from=entry-web /workspace/competition/modules/teams/web/dist competition/modules/teams/web/dist/
COPY --from=queue-web /workspace/competition/modules/queue/web/dist competition/modules/queue/web/dist/
COPY --from=registration-web /workspace/competition/modules/registration/web/dist competition/modules/registration/web/dist/
COPY --from=inspection-web /workspace/competition/modules/inspection/web/dist competition/modules/inspection/web/dist/
COPY --from=traffic-web /workspace/competition/modules/traffic/web/dist competition/modules/traffic/web/dist/
COPY --from=score-web /workspace/competition/modules/score/web/dist competition/modules/score/web/dist/
COPY --from=documents-web /workspace/competition/modules/documents/web/dist competition/modules/documents/web/dist/
COPY competition/entrypoint.sh /usr/local/bin/competition-entrypoint
ENV NODE_ENV=production
RUN mkdir -p data && chown -R node:node /app
EXPOSE 9200
ENTRYPOINT ["competition-entrypoint"]
CMD ["node", "competition/index.mjs"]
