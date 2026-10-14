# Multi-stage build for efficient container size
FROM node:26-alpine AS builder

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"
# GitHub PAT with read:packages, used only to install @wyre-ai/* from
# GitHub Packages. Passed as a build-time secret; never baked into the image.
ARG GITHUB_TOKEN=""

WORKDIR /app
COPY package*.json ./
RUN echo "@wyre-ai:registry=https://npm.pkg.github.com" > .npmrc && \
    echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> .npmrc && \
    npm ci --ignore-scripts && \
    rm -f .npmrc
COPY . .
RUN npm run build

FROM node:26-alpine AS production

RUN addgroup -g 1001 -S superops && \
    adduser -S superops -u 1001 -G superops

WORKDIR /app
COPY package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev && npm cache clean --force
RUN mkdir -p /app/logs && chown -R superops:superops /app
USER superops

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Bind every interface inside the container. Host publish is loopback in
# docker-compose. Startup still refuses to run without a real
# CONDUIT_S2S_SECRET (empty values and known placeholders exit). A wider
# bind is honored only when that secret is set. AUTH_MODE=gateway never
# falls back to image env credentials; the insecure-dev bypass is not for
# this image because it only binds 127.0.0.1.
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
ENV AUTH_MODE=gateway

VOLUME ["/app/logs"]
CMD ["node", "dist/index.js"]

LABEL maintainer="engineering@wyre.ai"
LABEL description="SuperOps MCP Server"
LABEL org.opencontainers.image.title="superops-mcp"
LABEL org.opencontainers.image.source="https://github.com/WYRE-AI/superops-mcp"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/superops-mcp"
