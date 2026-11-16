import fs from 'node:fs/promises';
import os from 'node:os';
import { run } from '../exec.js';

let distroCache;

export function parseOsRelease(text) {
  const map = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    map[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return map;
}

async function readDistro() {
  if (process.platform === 'linux') {
    const text = await fs.readFile('/etc/os-release', 'utf8');
    return parseOsRelease(text).PRETTY_NAME || 'Linux';
  }
  if (process.platform === 'darwin') {
    const result = await run('sw_vers');
    if (!result.ok) return 'macOS';
    const name = (result.stdout.match(/^ProductName:\s+(.+)$/m) || [])[1] || 'macOS';
    const version = (result.stdout.match(/^ProductVersion:\s+(.+)$/m) || [])[1] || '';
    return `${name} ${version}`.trim();
  }
  return process.platform;
}

function distro() {
  if (!distroCache) {
    distroCache = readDistro().catch(() => process.platform);
  }
  return distroCache;
}

export async function collectHost() {
  const cpus = os.cpus();
  const uptimeSeconds = Math.floor(os.uptime());
  return {
    hostname: os.hostname(),
    platform: process.platform,
    distro: await distro(),
    kernel: os.release(),
    arch: os.arch(),
    uptimeSeconds,
    bootTime: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
    load: os.loadavg().map((value) => Math.round(value * 100) / 100),
    cpuModel: cpus[0]?.model?.trim() || '',
    cpuCount: cpus.length,
    cpuSpeedMhz: cpus[0]?.speed || 0,
  };
}
