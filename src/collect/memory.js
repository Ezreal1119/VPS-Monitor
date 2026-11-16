import fs from 'node:fs/promises';
import os from 'node:os';
import { round1 } from './cpu.js';
import { run } from '../exec.js';

export function parseMeminfo(text) {
  const map = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)/);
    if (match) map[match[1]] = Number(match[2]) * 1024;
  }
  return map;
}

function snapshotFromMap(map) {
  const total = map.MemTotal || 0;
  const available = map.MemAvailable ?? ((map.MemFree || 0) + (map.Buffers || 0) + (map.Cached || 0));
  const swapTotal = map.SwapTotal || 0;
  const swapFree = map.SwapFree || 0;
  const used = Math.max(0, total - available);
  return {
    total,
    used,
    available,
    free: map.MemFree || 0,
    buffers: map.Buffers || 0,
    cached: map.Cached || 0,
    swapTotal,
    swapFree,
    swapUsed: Math.max(0, swapTotal - swapFree),
    usedPercent: total > 0 ? round1((used / total) * 100) : 0,
    source: 'proc',
  };
}

function snapshotFromOs() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);
  return {
    total,
    used,
    available: free,
    free,
    buffers: 0,
    cached: 0,
    swapTotal: 0,
    swapFree: 0,
    swapUsed: 0,
    usedPercent: total > 0 ? round1((used / total) * 100) : 0,
    source: 'os',
  };
}

export function parseVmStat(text) {
  const pageSize = Number((text.match(/page size of (\d+) bytes/) || [])[1] || 0);
  const pages = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^(.+?):\s+(\d+)\./);
    if (match) pages[match[1]] = Number(match[2]);
  }
  return { pageSize, pages };
}

export function parseSwapUsage(text) {
  const match = text.match(/total\s*=\s*([0-9.]+)([KMGT])\s+used\s*=\s*([0-9.]+)([KMGT])/i);
  if (!match) return { swapTotal: 0, swapUsed: 0 };
  const scale = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  const bytes = (value, unit) => Math.round(Number(value) * (scale[unit.toUpperCase()] || 1));
  return {
    swapTotal: bytes(match[1], match[2]),
    swapUsed: bytes(match[3], match[4]),
  };
}

async function collectDarwinMemory() {
  const [vm, swap] = await Promise.all([
    run('vm_stat'),
    run('sysctl', ['vm.swapusage']),
  ]);
  if (!vm.ok) return snapshotFromOs();
  const { pageSize, pages } = parseVmStat(vm.stdout);
  if (!pageSize) return snapshotFromOs();
  const available = ((pages['Pages free'] || 0) + (pages['Pages inactive'] || 0) + (pages['Pages speculative'] || 0)) * pageSize;
  const total = os.totalmem();
  const used = Math.max(0, total - available);
  const swapInfo = parseSwapUsage(`${swap.stdout}\n${swap.stderr}`);
  return {
    total,
    used,
    available,
    free: (pages['Pages free'] || 0) * pageSize,
    buffers: 0,
    cached: (pages['Pages inactive'] || 0) * pageSize,
    swapTotal: swapInfo.swapTotal,
    swapFree: Math.max(0, swapInfo.swapTotal - swapInfo.swapUsed),
    swapUsed: swapInfo.swapUsed,
    usedPercent: total > 0 ? round1((used / total) * 100) : 0,
    source: 'vm_stat',
  };
}

export async function collectMemory() {
  if (process.platform === 'linux') {
    try {
      const text = await fs.readFile('/proc/meminfo', 'utf8');
      return snapshotFromMap(parseMeminfo(text));
    } catch {
      return snapshotFromOs();
    }
  }
  if (process.platform === 'darwin') return collectDarwinMemory();
  return snapshotFromOs();
}
