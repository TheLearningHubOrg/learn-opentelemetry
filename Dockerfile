# Production Dockerfile for the Learn OpenTelemetry checkout service
# Stage 1 installs all dependencies, runs the test suite and compiles TypeScript.
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY tests ./tests

RUN npm test && npm run build

# Stage 2 ships compiled output plus production dependencies only.
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    OTEL_SERVICE_NAME=checkout-service \
    OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

USER node
EXPOSE 8080
# --import loads the SDK before any application module so auto-instrumentation can patch it.
CMD ["node", "--import", "./dist/instrumentation.js", "dist/index.js"]
