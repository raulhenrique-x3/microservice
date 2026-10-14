FROM node:25-bookworm-slim

# ffmpeg required by the worker; build toolchain only for native module fallback
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build
