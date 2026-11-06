# TruX sandbox: bash, curl, Python, Node and Chromium for the assistant's tools.
# Deployed as its own Cloud Run service (trux-sandbox) with a service account
# that has no project roles, so nothing run here can touch your project.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl wget git jq zip unzip python3 python3-pip python3-venv ffmpeg imagemagick \
      dnsutils iputils-ping ca-certificates fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs ./

ENV NODE_ENV=production PORT=8080 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 8080
CMD ["node", "server.mjs"]
