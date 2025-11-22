# Multi-stage build: compile TypeScript in one image, ship only the JS output
# and prod dependencies in the final image. Keeps the runtime image small
# (no ts-node, no devDeps) and avoids leaking source maps in production.

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Run as non-root for defense-in-depth.
RUN addgroup -S app && adduser -S app -G app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
USER app
EXPOSE 4000
# Container-aware health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/health > /dev/null || exit 1
CMD ["node", "dist/index.js"]
