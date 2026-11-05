# Burrow, internal / self-host image. Multi-arch (works on ARM64). The consumer path is the
# desktop app; this is for dev, testing and prosumer self-hosting.
#
#   docker compose up --build        (see compose.yaml; needs APP_PASSWORD and AUTH_SECRET)
#
# Burrow Pro (docs/adr/0001-open-core-split.md 3.10, R4): when the private Pro repo is checked out at pro/, the image
# holds the Pro server SOURCE (the runtime is unbundled) and the Pro UI inside dist/. Such an image is internal only:
# never push an image built with pro/ to any registry. Without pro/ this is a Free image.

# Base image pinned by tag plus multi-arch index digest. The tag lets Dependabot's docker
# ecosystem bump the digest within node:24-bookworm-slim (a bare digest made it track node:latest).
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` runs the root `prepare` script (node scripts/installHooks.js) before the rest of the
# source is copied. It no-ops without a .git directory, so only that one file is needed here.
# Scripts stay enabled so vite/rolldown install their native binaries normally.
COPY scripts/installHooks.js ./scripts/installHooks.js
RUN npm ci
COPY . .
RUN npm run build
# Only the Pro server code goes to the runtime stage (the Pro UI is already compiled into dist/); empty without pro/.
RUN mkdir -p /app/.pro-runtime && if [ -d pro/server ]; then cp -r pro/server /app/.pro-runtime/server; fi

# Same pinned digest as the build stage (node:24-bookworm-slim).
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    BURROW_DATA_DIR=/data \
    BURROW_HOST=0.0.0.0 \
    BURROW_PORT=4321
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.js loadEnv.js ./
COPY server ./server
COPY scripts/import.js ./scripts/import.js
COPY --from=build /app/dist ./dist
COPY --from=build /app/.pro-runtime/ ./pro/
RUN test ! -e pro/ui
# The image never ships the developer tools (devtools/ is neither copied nor in the build context): fail the
# build if one of their markers is in the runtime code or the UI, or the folder exists (docs/LICENSING.md 14.1).
RUN ! grep -rqF -e "BURROW_DEV_TOOLS=on" -e "/dev/license" server.js server dist
RUN test ! -e devtools
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4321/api/profile').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
