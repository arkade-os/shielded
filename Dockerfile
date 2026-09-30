FROM --platform=$BUILDPLATFORM golang:1.26.6-bookworm AS vm
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src/tools/vm
COPY tools/vm/go.mod tools/vm/go.sum ./
RUN go mod download
COPY tools/vm/ ./
RUN mkdir -p /out && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/shielded-vm .

FROM node:24-bookworm-slim AS app
WORKDIR /app
COPY package.json package-lock.json ./
COPY patches/ ./patches/
COPY tools/patch-sdk.mjs ./tools/patch-sdk.mjs
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 SHIELDED_DATA_DIR=/data
WORKDIR /app
COPY --from=app --chown=node:node /app/node_modules ./node_modules
COPY --from=app --chown=node:node /app/package.json ./package.json
COPY --from=app --chown=node:node /app/src ./src
COPY --from=app --chown=node:node /app/packages ./packages
COPY --from=app --chown=node:node /app/contracts ./contracts
COPY --from=app --chown=node:node /app/circuits/build ./circuits/build
COPY --from=app --chown=node:node /app/artifacts ./artifacts
COPY --from=app --chown=node:node /app/app/dist ./app/dist
COPY --from=vm --chown=node:node /out/shielded-vm ./bin/shielded-vm
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "src/server.ts"]
