FROM node:22-alpine

RUN apk add --no-cache python3 \
    && addgroup -S sandbox \
    && adduser -S -G sandbox sandbox

WORKDIR /app
COPY sandbox-runner.js ./sandbox-runner.js

ENV NODE_ENV=production
ENV PORT=8080

USER sandbox
EXPOSE 8080

CMD ["node", "sandbox-runner.js"]
