# Backend service image
FROM node:24-slim AS builder
WORKDIR /app

COPY backend/package*.json ./
RUN npm install

COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM node:24-slim
WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY backend/session-cache ./session-cache
COPY models ./models
RUN mkdir -p /app/session-cache

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    libglib2.0-0 \
    libgl1 \
    libgomp1 \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir --upgrade pip \
  && python3 -m pip install --no-cache-dir numpy pandas joblib matplotlib tqdm \
  && python3 -m pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

ENV PORT=4000
EXPOSE 4000
CMD ["node", "dist/server.js"]
