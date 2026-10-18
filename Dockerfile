FROM node:24-slim

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production

USER node

CMD ["node","src/server.js"]
