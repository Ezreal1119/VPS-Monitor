import fs from 'node:fs/promises';
import os from 'node:os';
import { run } from '../exec.js';

export function parseProcNetDev(text) {
  const counters = [];
  for (const line of text.split('\n').slice(2)) {
    const parts = line.split(':');
    if (parts.length < 2) continue;
    const fields = parts[1].trim().split(/\s+/);
    if (fields.length < 9) continue;
    counters.push({
      name: parts[0].trim(),
      rxBytes: Number(fields[0]),
      txBytes: Number(fields[8]),
    });
  }
  return counters;
}

export function parseNetstatIb(text) {
  const counters = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^(\S+)\s+\d+\s+<Link#[^>]+>\s+(.*)$/);
    if (!match) continue;
    const name = match[1].replace(/\*$/, '');
    let fields = match[2].trim().split(/\s+/);
    if (fields[0] && fields[0].includes(':')) fields = fields.slice(1);
    if (fields.length < 6) continue;
    const rxBytes = Number(fields[2]);
    const txBytes = Number(fields[5]);
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
    counters.push({ name, rxBytes, txBytes });
  }
  return counters;
}

export async function readNetCounters() {
  try {
    if (process.platform === 'linux') {
      return parseProcNetDev(await fs.readFile('/proc/net/dev', 'utf8'));
    }
    if (process.platform === 'darwin') {
      const result = await run('netstat', ['-ibn']);
      return result.ok ? parseNetstatIb(result.stdout) : [];
    }
  } catch {
    return [];
  }
  return [];
}

export function interfaceAddresses() {
  let nics = {};
  try {
    nics = os.networkInterfaces() || {};
  } catch {
    return [];
  }
  const interfaces = [];
  for (const [name, addresses] of Object.entries(nics)) {
    if (!addresses) continue;
    const formatted = [];
    for (const address of addresses) {
      const family = address.family === 4 || address.family === 'IPv4'
        ? 'ipv4'
        : address.family === 6 || address.family === 'IPv6'
          ? 'ipv6'
          : '';
      if (!family) continue;
      if (family === 'ipv6' && address.address.startsWith('fe80')) continue;
      formatted.push({
        address: address.address,
        family,
        internal: Boolean(address.internal),
      });
    }
    interfaces.push({ name, addresses: formatted });
  }
  return interfaces;
}

export function diffNet(previous, next, seconds) {
  const prior = new Map((previous || []).map((item) => [item.name, item]));
  return next.map((item) => {
    const old = prior.get(item.name);
    if (!old || seconds <= 0) return { ...item, rxRate: 0, txRate: 0 };
    return {
      ...item,
      rxRate: Math.max(0, (item.rxBytes - old.rxBytes) / seconds),
      txRate: Math.max(0, (item.txBytes - old.txBytes) / seconds),
    };
  });
}

function roundRate(value) {
  if (value == null || Number.isNaN(value)) return null;
  return Math.max(0, Math.round(value));
}

export function buildNetwork(rated) {
  const known = new Map(interfaceAddresses().map((item) => [item.name, item.addresses]));
  const names = new Set([...known.keys(), ...rated.map((item) => item.name)]);
  const rates = new Map(rated.map((item) => [item.name, item]));
  const interfaces = [];

  for (const name of names) {
    if (name === 'lo' || name === 'lo0') continue;
    const rate = rates.get(name);
    const addresses = (known.get(name) || []).filter((item) => !item.internal);
    const rxBytes = rate ? rate.rxBytes : null;
    const txBytes = rate ? rate.txBytes : null;
    const live = (rate?.rxRate || 0) >= 1024 || (rate?.txRate || 0) >= 1024;
    if (addresses.length === 0 && !live) continue;
    interfaces.push({
      name,
      addresses,
      rxBytes,
      txBytes,
      rxRate: rate ? roundRate(rate.rxRate) : null,
      txRate: rate ? roundRate(rate.txRate) : null,
    });
  }

  interfaces.sort((a, b) => {
    const score = (item) => (item.addresses.some((address) => address.family === 'ipv4') ? 0 : 1);
    return score(a) - score(b) || a.name.localeCompare(b.name);
  });

  const hasRates = interfaces.some((item) => item.rxRate != null);
  const rxRate = hasRates ? interfaces.reduce((sum, item) => sum + (item.rxRate || 0), 0) : null;
  const txRate = hasRates ? interfaces.reduce((sum, item) => sum + (item.txRate || 0), 0) : null;
  return { interfaces, rxRate, txRate };
}
