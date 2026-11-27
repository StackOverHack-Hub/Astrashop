# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 PUBLIC_DIR=/app/public
WORKDIR /app/backend
COPY --from=dependencies --chown=node:node /app/backend/node_modules ./node_modules
COPY --chown=node:node backend/package.json backend/server.mjs backend/sample-items.mjs ./
COPY --chown=node:node backend/src ./src
COPY --from=frontend --chown=node:node /build/dist /app/public
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=100s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
