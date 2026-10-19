FROM node:22-alpine

# Chromium enables real browser rendering for TruX-Code visual inspection.
RUN apk add --no-cache chromium nss freetype harfbuzz ttf-freefont ca-certificates

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

COPY package.json ./
RUN npm install --omit=dev
COPY cloud-run-server.js ./cloud-run-server.js
COPY public ./public
COPY functions ./functions

EXPOSE 8080

CMD ["npm", "start"]
