# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder
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

COPY shared shared/
COPY inspection/lib inspection/lib/
COPY traffic/lib traffic/lib/
COPY score/lib score/lib/
COPY entry/web entry/web/
COPY queue/web queue/web/
COPY registration/web registration/web/
COPY inspection/web inspection/web/
COPY traffic/web traffic/web/
COPY score/web score/web/
COPY documents/web documents/web/
RUN set -e; for service in entry queue registration inspection traffic score documents; do pnpm --dir "$service/web" run build; done
RUN pnpm --filter ./competition deploy --prod /prod/competition

FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY --from=builder /prod/competition/node_modules node_modules/
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
COPY --from=builder /workspace/entry/web/dist entry/web/dist/
COPY --from=builder /workspace/queue/web/dist queue/web/dist/
COPY --from=builder /workspace/registration/web/dist registration/web/dist/
COPY --from=builder /workspace/inspection/web/dist inspection/web/dist/
COPY --from=builder /workspace/traffic/web/dist traffic/web/dist/
COPY --from=builder /workspace/score/web/dist score/web/dist/
COPY --from=builder /workspace/documents/web/dist documents/web/dist/
COPY competition/entrypoint.sh /usr/local/bin/competition-entrypoint
ENV NODE_ENV=production
RUN mkdir -p data && chown -R node:node /app
EXPOSE 9200
ENTRYPOINT ["competition-entrypoint"]
CMD ["node", "competition/index.mjs"]
