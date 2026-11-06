FROM node:22-alpine

RUN apk add --no-cache ca-certificates

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY database.rules.json metadata.json ./
RUN node scripts/check.mjs

USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
