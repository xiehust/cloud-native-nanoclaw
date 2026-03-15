FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production=false
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-slim

# System dependencies (same as NanoClaw's container/Dockerfile)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser / Puppeteer
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Install claude-code and agent-browser globally
RUN npm install -g @anthropic-ai/claude-code agent-browser

# App setup
WORKDIR /app
COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/node_modules ./node_modules/
COPY package.json ./

# Workspace directories (mirrors NanoClaw's /workspace layout)
RUN mkdir -p /workspace/group /workspace/global /workspace/shared /workspace/extra /home/node/.claude

# Set ownership to non-root user
RUN chown -R node:node /workspace && chmod 777 /home/node

# Environment
ENV CLAUDE_CODE_USE_BEDROCK=1
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

USER node
CMD ["node", "dist/server.js"]
