# F1 Stuff Monorepo

This repository hosts both the backend API and frontend dashboard for the Formula 1 data project.

## Workspaces

- `backend/` – Koa + TypeScript service that proxies and caches session data from openf1.org.
- `frontend/` – React + Vite app for displaying aggregated telemetry.

## Useful scripts

```bash
# Backend
npm run backend:dev
npm run backend:build

# Frontend
npm run frontend:dev
npm run frontend:build
```

Set `SESSION_CACHE_DIR=/path/to/cache` before starting the backend to change where session responses are saved.
