# Ex Libris — single-container personal library
FROM node:22-bookworm-slim AS deps
# Build tools are only needed if a native module has to compile from source.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim

# poppler-utils: PDF covers and page counts. tini: clean signal handling.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY admin ./admin

ARG APP_VERSION=dev
ENV PORT=3000 DATA_DIR=/data LIBRARY_DIRS=/library APP_VERSION=$APP_VERSION
RUN mkdir -p /data /library && chown -R node:node /data
VOLUME ["/data"]
EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
