// Read-only VPS monitor.
// HOST defaults to 127.0.0.1, PORT defaults to 8787.
// Set MONITOR_TOKEN to require a token on every /api request.

import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSampler } from './sampler.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

const host = process.env.HOST || '127.0.0.1';
const port = readPort(process.env.PORT || '8787');
const token = (process.env.MONITOR_TOKEN || '').trim();

const sampler = startSampler({
  version: pkg.version,
  startedAt: new Date().toISOString(),
  platform: process.platform,
  listen: `${host}:${port}`,
  auth: Boolean(token),
});

const routes = new Map([
  ['/api/health', async () => ({ ok: true, agent: sampler.agent(), collectedAt: new Date().toISOString() })],
  ['/api/overview', () => sampler.overview()],
  ['/api/host', () => sampler.section('host')],
  ['/api/cpu', () => sampler.section('cpu')],
  ['/api/memory', () => sampler.section('memory')],
  ['/api/disks', () => sampler.section('disks')],
  ['/api/network', () => sampler.section('network')],
  ['/api/services', () => sampler.section('services')],
  ['/api/ports', () => sampler.section('ports')],
  ['/api/firewall', () => sampler.section('firewall')],
]);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function readPort(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    console.error('PORT 必须是 1 到 65535 的整数');
    process.exit(1);
  }
  return value;
}

function sameSecret(given) {
  if (!token) return true;
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

function presentedToken(req) {
  const header = req.headers['x-monitor-token'];
  if (typeof header === 'string' && header) return header;
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice(7);
  }
  return '';
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function publicPath(pathname) {
  const name = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(publicDir, `.${name}`);
  if (file !== publicDir && !file.startsWith(`${publicDir}${path.sep}`)) return null;
  return file;
}

async function sendFile(res, file) {
  const type = types[path.extname(file)];
  if (!type) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'content-length': data.length,
    });
    res.end(data);
  } catch (error) {
    if (error.code === 'ENOENT') sendJson(res, 404, { error: 'not found' });
    else throw error;
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
  });
});

async function handle(req, res) {
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (pathname === '/api') {
    if (!sameSecret(presentedToken(req))) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    sendJson(res, 200, { endpoints: [...routes.keys()] });
    return;
  }
  if (pathname.startsWith('/api/')) {
    const route = routes.get(pathname);
    if (!route) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!sameSecret(presentedToken(req))) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const body = await route();
    if (!body) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, body);
    return;
  }

  const file = publicPath(pathname);
  if (!file) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  await sendFile(res, file);
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用`);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

await sampler.ready;
server.listen(port, host, () => {
  console.log(`VPS monitor  http://${host}:${port}`);
  console.log(token ? '访问令牌：已要求' : '访问令牌：未设置');
});
