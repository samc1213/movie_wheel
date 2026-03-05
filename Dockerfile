FROM node:22-alpine

RUN apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  ttf-freefont

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY package.json package-lock.json ./
RUN PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm ci --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
