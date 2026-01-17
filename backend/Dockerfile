# Backend service image
FROM mcr.microsoft.com/dotnet/sdk:9.0-bookworm-slim AS builder
WORKDIR /app

COPY backend/backend.csproj ./backend/
RUN dotnet restore ./backend/backend.csproj

COPY backend ./backend
RUN dotnet publish ./backend/backend.csproj -c Release -o /app/publish

ARG DATABASE_URL
RUN if [ -z "$DATABASE_URL" ]; then echo "DATABASE_URL build arg required to generate assets" && exit 1; fi
ENV DATABASE_URL=$DATABASE_URL
WORKDIR /app/backend
RUN dotnet run --project ./backend.csproj -- build-track-heatmaps \
  && dotnet run --project ./backend.csproj -- build-track-speed-maps
WORKDIR /app

FROM mcr.microsoft.com/dotnet/aspnet:9.0-bookworm-slim
WORKDIR /app

COPY --from=builder /app/publish ./
COPY --from=builder /app/backend/assets ./assets
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
CMD ["dotnet", "backend.dll"]
