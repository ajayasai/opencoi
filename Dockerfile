# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
    && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ARG VERSION=development
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="OpenCOI" \
      org.opencontainers.image.description="Explainable, self-hosted certificate of insurance tracking" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/ajayasai/opencoi" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$VCS_REF"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4174 \
    TRUST_PROXY_HOPS=0 \
    APP_ORIGIN=http://localhost:4174 \
    COOKIE_SECURE=false \
    DATA_DIR=/app/data \
    DATABASE_PATH=/app/data/opencoi.sqlite \
    UPLOAD_DIR=/app/data/uploads

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/LICENSE ./LICENSE
COPY --from=build --chown=node:node /app/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY --from=build --chown=node:node /app/third_party_licenses ./third_party_licenses
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

RUN mkdir -p /app/data/uploads \
    && chown -R node:node /app/data

USER node

VOLUME ["/app/data"]
EXPOSE 4174

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '4174') + '/api/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "--enable-source-maps", "dist/server/index.js"]
