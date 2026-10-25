FROM node:22-alpine

RUN apk add --no-cache ca-certificates

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY cloud-run-server.js ./cloud-run-server.js
COPY public ./public
COPY functions ./functions

RUN npm run build

EXPOSE 8080

CMD ["npm", "start"]
