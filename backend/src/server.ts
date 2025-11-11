import Koa from 'koa';
import Router from '@koa/router';
import path from 'path';
import { promises as fs } from 'fs';
import { fetchOpenF1Session, OpenF1SessionData } from './datasources/openf1org';

const DEFAULT_PORT = 4000;

const parsedPort = Number(process.env.PORT);
const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;

const CACHE_DIR = process.env.SESSION_CACHE_DIR
  ? path.resolve(process.env.SESSION_CACHE_DIR)
  : path.resolve(process.cwd(), 'session-cache');

const inFlightFetches = new Map<string, Promise<OpenF1SessionData>>();

const app = new Koa();
const router = new Router();

app.use(async (ctx, next) => {
  const startedAt = Date.now();

  try {
    await next();
  } catch (error) {
    console.error('Unhandled error', error);
    ctx.status = 500;
    ctx.body = { error: 'Internal server error' };
  } finally {
    const duration = Date.now() - startedAt;
    console.log(`[HTTP] ${ctx.method} ${ctx.url} -> ${ctx.status} (${duration}ms)`);
  }
});

app.use(async (ctx, next) => {
  ctx.set('Access-Control-Allow-Origin', '*');
  ctx.set('Access-Control-Allow-Headers', ctx.get('Access-Control-Request-Headers') || '*');
  ctx.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');

  if (ctx.method === 'OPTIONS') {
    ctx.status = 204;
    return;
  }

  await next();
});

router.get('/session/:key', async (ctx) => {
  const sessionKey = ctx.params.key?.trim();

  if (!sessionKey) {
    ctx.status = 400;
    ctx.body = { error: 'Session key is required' };
    return;
  }

  try {
    const data = await getSessionData(sessionKey);
    ctx.body = data;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    ctx.status = 502;
    ctx.body = { error: 'Failed to fetch session data', detail: message };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

ensureCacheDir()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Backend API listening on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize cache directory', error);
    process.exit(1);
  });

export default app;

async function getSessionData(sessionKey: string): Promise<OpenF1SessionData> {
  const cached = await readSessionFromDisk(sessionKey);
  if (cached) {
    return cached;
  }

  const existingPromise = inFlightFetches.get(sessionKey);
  if (existingPromise) {
    return existingPromise;
  }

  const fetchPromise = fetchOpenF1Session(sessionKey)
    .then(async (data) => {
      await writeSessionToDisk(sessionKey, data);
      return data;
    })
    .finally(() => {
      inFlightFetches.delete(sessionKey);
    });

  inFlightFetches.set(sessionKey, fetchPromise);
  return fetchPromise;
}

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

function sanitizeSessionKey(sessionKey: string) {
  return sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getCacheFilePath(sessionKey: string) {
  const safeKey = sanitizeSessionKey(sessionKey);
  return path.join(CACHE_DIR, `${safeKey}.json`);
}

async function readSessionFromDisk(sessionKey: string): Promise<OpenF1SessionData | null> {
  const filePath = getCacheFilePath(sessionKey);

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as OpenF1SessionData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw new Error(`Failed to read cache for session ${sessionKey}: ${String(error)}`);
  }
}

async function writeSessionToDisk(sessionKey: string, data: OpenF1SessionData) {
  const filePath = getCacheFilePath(sessionKey);
  await fs.writeFile(filePath, JSON.stringify(data));
}
