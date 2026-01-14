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
    python3-venv \
    python3-pip \
    libglib2.0-0 \
    libgl1 \
    libgomp1 \
  && rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
ENV PYTHON_BIN="$VIRTUAL_ENV/bin/python"

RUN pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir numpy pandas joblib matplotlib tqdm \
  && pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

ENV PORT=4000
EXPOSE 4000
CMD ["node", "dist/server.js"]
