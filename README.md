# F1 Stuff Monorepo

This repository hosts both the backend API and frontend dashboard for the Formula 1 data project.

## Workspaces

- `backend/` – Koa + TypeScript service that serves telemetry stored in TimescaleDB.
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

## Importing sessions

Sessions must exist in the database before the API can serve them. Use the import script to load either a cached export or fresh data from openf1.org:

```bash
# From a local export (JSON or gzip/zip)
bun run import-session -- --file ./session-cache/9693.json.zip

# Directly from openf1.org using the session key
bun run import-session -- --session 9693

# Legacy behaviour: pass a path without flags
bun run import-session -- ./session-cache/9693.json.zip
```

After importing, start the backend and request `/session/<key>`; the API responds with `404` when a session has not been imported.

## Models & datasets

- `models/xgboost_sc_predict.ipynb` – consumes the backend safety-car dataset for model training.
- `models/jolpica_lap_dataset.ipynb` – builds `models/driver_lap_dataset.csv` from the archived Jolpica dump (static historic data without tyres/weather/SC fields).
- `models/fastf1_lap_dataset.ipynb` – uses the FastF1 library to download official timing data (laps, weather, track/DRS status) and build an enriched lap dataset with the previously missing fields.

TODO
-> This loader https://codepen.io/Elvira-Ho/pen/jvmRNK
-> Display the track layout in race replayer
-> Remove dnf car from the race (when stop moving)
-> Make the race replayer streaming
