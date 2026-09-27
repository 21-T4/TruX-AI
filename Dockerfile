FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json ./
COPY cloud-run-server.js ./cloud-run-server.js
COPY public ./public
COPY functions ./functions

EXPOSE 8080

CMD ["npm", "start"]
