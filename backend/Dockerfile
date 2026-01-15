# Backend service image
FROM node:24-slim AS builder
WORKDIR /app

COPY backend/package*.json ./
RUN npm install

COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

ARG DATABASE_URL
RUN if [ -z "$DATABASE_URL" ]; then echo "DATABASE_URL build arg required to generate assets" && exit 1; fi
ENV DATABASE_URL=$DATABASE_URL
RUN node dist/scripts/build-track-heatmaps.js \
  && node dist/scripts/build-track-speed-maps.js

FROM node:24-slim
WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/assets ./assets
COPY backend/session-cache ./session-cache
COPY models ./models
RUN mkdir -p /app/session-cache

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
    python3-dev \
    build-essential \
    gfortran \
    pkg-config \
    libopenblas-dev \
    libglib2.0-0 \
    libgl1 \
    libgomp1 \
  && rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
ENV PYTHON_BIN="$VIRTUAL_ENV/bin/python"

RUN pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir numpy==1.26.4 scipy==1.11.4 \
  && pip install --no-cache-dir pandas joblib matplotlib tqdm scikit-learn==1.7.2 \
  && pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

ENV PORT=4000
EXPOSE 4000
CMD ["node", "dist/server.js"]
