FROM node:24-alpine AS runtime

RUN apk update && apk upgrade --no-cache

WORKDIR /app/backend

ENV DATA_FILE=/app/backend/data/incidents.json
ENV NODE_ENV=production
ENV PORT=8080

COPY backend/package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY backend/src ./src
COPY docs/api/openapi.yaml /app/docs/api/openapi.yaml

RUN addgroup -S opsboard \
  && adduser -S opsboard -G opsboard \
  && mkdir -p /app/backend/data \
  && chown -R opsboard:opsboard /app

USER opsboard

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
