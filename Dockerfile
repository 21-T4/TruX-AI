FROM node:22-alpine

RUN apk add --no-cache ca-certificates

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY cloud-run-server.js ./cloud-run-server.js
COPY public ./public
COPY functions ./functions
COPY metadata.json ./

RUN npm run build

# The packaged application only needs read access at runtime.
USER node

EXPOSE 8080

CMD ["npm", "start"]
