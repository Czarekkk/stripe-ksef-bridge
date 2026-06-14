# Obraz kontenera (Railway / dowolny PaaS z wolumenem).
# syntax=docker/dockerfile:1

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Railway wstrzykuje PORT i zmienne środowiskowe (process.env). tsx uruchamia TS.
# Ledger (DATABASE_URL=file:/data/...) trzymaj na wolumenie zamontowanym w /data.
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/server.ts"]
