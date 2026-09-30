import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DemoEngine } from './engine.ts';

type Action = 'bootstrap' | 'sync' | 'shield' | 'seal' | 'transfer' | 'withdraw' | 'reset' | 'replay' | 'tamper' | 'recover' | 'rebase';
type Engine = Pick<DemoEngine, 'snapshot'> & {
  action(action: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<unknown>;
  close(): void | Promise<void>;
};
export type ServerConfig = {
  host: string; port: number; dataDirectory: string; network: 'local-emulator' | 'mutinynet';
  arkUrl: string; emulatorUrl: string; apiToken?: string; storageKey?: string;
};
type ServerOptions = { config: ServerConfig; engine?: Engine; initializationError?: string };

const actions = new Set<Action>(['bootstrap', 'sync', 'shield', 'seal', 'transfer', 'withdraw', 'reset', 'replay', 'tamper', 'recover', 'rebase']);
const cookieName = 'shielded_session';
const cookieAgeSeconds = 12 * 60 * 60;
const loginWindowMs = 15 * 60_000;
const loginLimit = 5;
const root = fileURLToPath(new URL('../app/dist', import.meta.url));

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.HOST ?? '127.0.0.1';
  const network = env.SHIELDED_NETWORK ?? 'local-emulator';
  if (network !== 'local-emulator' && network !== 'mutinynet') throw new Error('SHIELDED_NETWORK must be local-emulator or mutinynet');
  const apiToken = env.SHIELDED_API_TOKEN;
  if ((!isLoopback(host) || network === 'mutinynet' || env.NODE_ENV === 'production') && (!apiToken || apiToken.length < 32)) {
    throw new Error('Set SHIELDED_API_TOKEN to at least 32 characters for Mutinynet or non-loopback deployment');
  }
  return { host, port: parsePort(env.PORT ?? '8787'), dataDirectory: resolve(env.SHIELDED_DATA_DIR ?? './data'), network,
    arkUrl: env.ARK_SERVER_URL ?? 'https://mutinynet.arkade.sh',
    emulatorUrl: env.EMULATOR_URL ?? 'https://emulator.mutinynet.arkade.sh', apiToken,
    storageKey: env.SHIELDED_STORAGE_KEY };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  return port;
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || (isIP(normalized) === 4 && normalized.split('.')[0] === '127');
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

function sessionValue(token: string, expires: number): string {
  const payload = `v1.${expires}`;
  return `${payload}.${createHmac('sha256', token).update(payload).digest('base64url')}`;
}

function validSession(value: string | undefined, token: string): boolean {
  if (!value) return false;
  const [version, expiryText, signature, extra] = value.split('.');
  const expires = Number(expiryText);
  if (version !== 'v1' || extra !== undefined || !Number.isSafeInteger(expires) || expires <= Date.now()) return false;
  return sameSecret(sessionValue(token, expires), value);
}

function cookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const split = part.trim().indexOf('=');
    if (split >= 0 && part.trim().slice(0, split) === name) return part.trim().slice(split + 1);
  }
  return undefined;
}

function requestIsSecure(request: Request, config: ServerConfig): boolean {
  return config.network === 'mutinynet' || !isLoopback(config.host) || request.secure;
}

function sameOrigin(request: Request): boolean {
  const origin = request.get('origin');
  if (!origin) return false;
  try { return new URL(origin).host.toLowerCase() === request.get('host')?.toLowerCase(); }
  catch { return false; }
}

export function createApp({ config, engine: initialEngine, initializationError: initialError }: ServerOptions): Express & { setEngine(engine?: Engine, error?: string): void } {
  const app = express();
  let engine = initialEngine;
  let initializationError = initialError;
  let busy = false;
  const attempts = new Map<string, number[]>();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb', strict: true }));

  const authenticate = (request: Request): 'none' | 'bearer' | 'cookie' | 'local' => {
    if (!config.apiToken) return 'local';
    const authorization = request.get('authorization');
    if (authorization?.startsWith('Bearer ') && sameSecret(authorization.slice(7), config.apiToken)) return 'bearer';
    if (validSession(cookie(request, cookieName), config.apiToken)) return 'cookie';
    return 'none';
  };
  const privateApi = (request: Request, response: Response, next: NextFunction) => {
    const auth = authenticate(request);
    if (auth === 'none') { response.status(401).json({ error: 'Authentication required' }); return; }
    if (auth === 'cookie' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !sameOrigin(request)) {
      response.status(403).json({ error: 'Same-origin request required' }); return;
    }
    next();
  };
  const allowedActions = (): Action[] => {
    const standard = config.network === 'mutinynet'
      ? ['bootstrap', 'sync', 'shield', 'seal', 'transfer', 'withdraw', 'recover'] as Action[]
      : ['shield', 'seal', 'transfer', 'withdraw', 'reset', 'replay', 'tamper', 'recover', 'rebase'] as Action[];
    try {
      const advertised = engine?.snapshot().status as Record<string, unknown> | undefined;
      const engineAllowed = advertised?.allowedActions;
      if (Array.isArray(engineAllowed)) return standard.filter(action => engineAllowed.includes(action));
    } catch { return []; }
    return standard;
  };
  const apiSnapshot = () => {
    const state = engine!.snapshot();
    return { ...state, status: { ...((state.status ?? {}) as Record<string, unknown>), allowedActions: allowedActions(), network: config.network } };
  };
  const isReady = () => {
    if (!engine || initializationError) return false;
    try {
      const status = (engine.snapshot().status ?? {}) as Record<string, unknown>;
      return status.ready === true && status.faulted !== true && status.reconciliationRequired !== true;
    } catch { return false; }
  };

  app.get('/healthz', (_request, response) => response.json({ live: true }));
  app.get('/readyz', (_request, response) => {
    const ready = isReady();
    response.status(ready ? 200 : 503).json({ ready, network: config.network });
  });
  app.get('/api/session', (request, response) => {
    const auth = authenticate(request);
    response.json({ enabled: !!config.apiToken, authenticated: auth !== 'none' });
  });
  app.post('/api/session', (request, response) => {
    if (!sameOrigin(request)) { response.status(403).json({ error: 'Same-origin request required' }); return; }
    if (!config.apiToken) { response.status(404).json({ error: 'Session login is not enabled' }); return; }
    const key = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const recent = (attempts.get(key) ?? []).filter(time => time > now - loginWindowMs);
    if (recent.length >= loginLimit) { response.status(429).json({ error: 'Too many login attempts' }); return; }
    if (!attempts.has(key) && attempts.size >= 10_000) {
      for (const [address, times] of attempts) if (!times.some(time => time > now - loginWindowMs)) attempts.delete(address);
      if (attempts.size >= 10_000) { response.status(429).json({ error: 'Too many login attempts' }); return; }
    }
    recent.push(now); attempts.set(key, recent);
    const supplied = typeof request.body?.token === 'string' ? request.body.token : '';
    if (!sameSecret(supplied, config.apiToken)) { response.status(401).json({ error: 'Invalid token' }); return; }
    attempts.delete(key);
    const expires = Date.now() + cookieAgeSeconds * 1000;
    response.setHeader('Set-Cookie', `${cookieName}=${sessionValue(config.apiToken, expires)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cookieAgeSeconds}${requestIsSecure(request, config) ? '; Secure' : ''}`);
    response.json({ authenticated: true, expiresAt: new Date(expires).toISOString() });
  });
  app.delete('/api/session', (request, response) => {
    if (!sameOrigin(request)) { response.status(403).json({ error: 'Same-origin request required' }); return; }
    response.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${requestIsSecure(request, config) ? '; Secure' : ''}`);
    response.status(204).end();
  });

  app.use('/api', privateApi);
  app.get('/api/state', (_request, response) => {
    if (!engine) { response.status(503).json({ error: 'Runtime is initializing or unavailable' }); return; }
    response.json(apiSnapshot());
  });
  app.post('/api/actions/:action', async (request, response) => {
    const action = request.params.action as Action;
    if (!actions.has(action)) { response.status(404).json({ error: 'Unknown action' }); return; }
    if (!allowedActions().includes(action)) { response.status(403).json({ error: 'Action is disabled for Mutinynet deployments' }); return; }
    if (!engine) { response.status(503).json({ error: 'Runtime is initializing or unavailable' }); return; }
    if (busy) { response.status(409).json({ error: 'A proof or settlement is already in progress' }); return; }
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) { response.status(400).json({ error: 'Expected a JSON object' }); return; }
    const idempotencyKey = request.get('idempotency-key');
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
      response.status(400).json({ error: 'Invalid Idempotency-Key' }); return;
    }
    if (config.network === 'mutinynet' && !idempotencyKey) {
      response.status(400).json({ error: 'Idempotency-Key is required for Mutinynet actions' }); return;
    }
    busy = true;
    try {
      const result = await engine.action(action, request.body as Record<string, unknown>, idempotencyKey);
      response.json({ state: apiSnapshot(), result });
    } catch (error) {
      response.status(422).json({ error: error instanceof Error ? error.message : String(error), state: apiSnapshot() });
    } finally { busy = false; }
  });
  app.use(express.static(root));
  app.get('/', (_request, response) => response.sendFile(resolve(root, 'index.html')));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
    response.status(status === 413 ? 413 : status === 400 ? 400 : 500).json({ error: status === 413 ? 'Request body is too large' : status === 400 ? 'Malformed JSON request' : 'Internal server error' });
  });
  Object.assign(app, { setEngine(value?: Engine, error?: string) { engine = value; initializationError = error; } });
  return app as Express & { setEngine(engine?: Engine, error?: string): void };
}

export async function createDeploymentEngine(config: ServerConfig): Promise<DemoEngine> {
  await mkdir(config.dataDirectory, { recursive: true });
  const { createDemoEngine } = await import('./engine.ts');
  return createDemoEngine({ dataDirectory: config.dataDirectory, network: config.network,
    arkUrl: config.arkUrl, emulatorUrl: config.emulatorUrl, storageKey: config.storageKey });
}

export function startServer(config = loadServerConfig()) {
  const app = createApp({ config });
  const server = app.listen(config.port, config.host, () => console.log(`Shielded API listening on ${config.host}:${config.port}`));
  let engine: DemoEngine | undefined;
  const ready = createDeploymentEngine(config).then(value => { engine = value; app.setEngine(value); }).catch(error => {
    app.setEngine(undefined, error instanceof Error ? error.message : String(error));
    console.error('Shielded engine initialization failed');
  });
  let stopping: Promise<void> | undefined;
  const close = () => stopping ??= (async () => {
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    await ready;
    await engine?.close();
  })();
  return { app, server, ready, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const running = startServer();
    const { close } = running;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().finally(() => process.exit(0)); });
    void running.ready;
  } catch (error) { console.error(error instanceof Error ? error.message : 'Server startup failed'); process.exitCode = 1; }
}
