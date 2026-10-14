FROM node:25-bookworm-slim

# ffmpeg required by the worker; build toolchain only for native module fallback
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/services

# workspace manifests first so npm ci resolves the workspace graph
COPY services/package.json services/package-lock.json ./
COPY services/packages/shared/package.json packages/shared/package.json
COPY services/apps/api/package.json apps/api/package.json
COPY services/apps/worker/package.json apps/worker/package.json
COPY services/apps/notifier/package.json apps/notifier/package.json
RUN npm ci --no-audit --no-fund

# only this service's code + the shared library it imports
COPY services/tsconfig.base.json tsconfig.base.json
COPY services/packages/shared packages/shared
COPY services/apps/worker apps/worker
RUN npm run build -w @app/shared && npm run generate -w @app/worker && npm run build -w @app/worker
