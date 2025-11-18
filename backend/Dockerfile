# Backend service image
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY session-cache ./session-cache
RUN mkdir -p /app/session-cache

ENV PORT=4000
EXPOSE 4000
CMD ["node", "dist/server.js"]
