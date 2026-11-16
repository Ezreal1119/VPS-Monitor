import os from 'node:os';
import { diffCpus } from './collect/cpu.js';
import { collectDisks } from './collect/disks.js';
import { collectFirewall } from './collect/firewall.js';
import { collectHost } from './collect/host.js';
import { collectMemory } from './collect/memory.js';
import { buildNetwork, diffNet, readNetCounters } from './collect/network.js';
import { collectPorts } from './collect/ports.js';
import { collectServices } from './collect/services.js';

const HISTORY = 90;
const TTL = {
  disks: 15000,
  services: 10000,
  ports: 10000,
  firewall: 30000,
};

function slot() {
  return { at: 0, data: null, pending: null };
}

function pushHistory(list, point) {
  list.push(point);
  if (list.length > HISTORY) list.splice(0, list.length - HISTORY);
}

async function cached(entry, ttl, collect) {
  const now = Date.now();
  if (entry.data && now - entry.at < ttl) return entry.data;
  if (entry.pending) return entry.pending;
  entry.pending = collect()
    .then((data) => {
      entry.data = data;
      entry.at = Date.now();
      entry.pending = null;
      return data;
    })
    .catch((error) => {
      entry.pending = null;
      if (entry.data) return entry.data;
      return { available: false, note: error.message };
    });
  return entry.pending;
}

export function startSampler(agent) {
  const state = {
    cpuPrev: os.cpus(),
    cpu: { usagePercent: 0, cores: [] },
    cpuHistory: [],
    netPrev: [],
    netAt: Date.now(),
    network: { interfaces: [], rxRate: null, txRate: null },
    netHistory: [],
    host: null,
    memory: null,
  };
  const slots = {
    disks: slot(),
    services: slot(),
    ports: slot(),
    firewall: slot(),
  };
  let fastBusy = false;

  async function refreshFast() {
    if (fastBusy) return;
    fastBusy = true;
    try {
      const nextCpu = os.cpus();
      state.cpu = diffCpus(state.cpuPrev, nextCpu);
      state.cpuPrev = nextCpu;
      const now = Date.now();
      pushHistory(state.cpuHistory, { t: now, usagePercent: state.cpu.usagePercent });

      state.host = await collectHost();
      state.memory = await collectMemory();

      const counters = await readNetCounters();
      const seconds = (now - state.netAt) / 1000;
      const rated = diffNet(state.netPrev, counters, seconds);
      state.netPrev = counters;
      state.netAt = Date.now();
      state.network = buildNetwork(rated);
      pushHistory(state.netHistory, {
        t: state.netAt,
        rxRate: state.network.rxRate,
        txRate: state.network.txRate,
      });
    } catch (error) {
      console.error('collect failed:', error.message);
    } finally {
      fastBusy = false;
    }
  }

  async function prime() {
    state.cpuPrev = os.cpus();
    state.netPrev = await readNetCounters();
    state.netAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await refreshFast();
  }

  const ready = prime().then(() => {
    const timer = setInterval(() => {
      refreshFast().catch((error) => {
        console.error('collect failed:', error.message);
      });
    }, 2000);
    timer.unref();
  });

  function meta() {
    return { ...agent };
  }

  async function disks() {
    return cached(slots.disks, TTL.disks, collectDisks);
  }
  async function services() {
    return cached(slots.services, TTL.services, collectServices);
  }
  async function ports() {
    return cached(slots.ports, TTL.ports, collectPorts);
  }
  async function firewall() {
    return cached(slots.firewall, TTL.firewall, collectFirewall);
  }

  return {
    ready,
    agent: meta,
    async overview() {
      await ready;
      const [diskInfo, serviceInfo, portInfo, firewallInfo] = await Promise.all([
        disks(),
        services(),
        ports(),
        firewall(),
      ]);
      return {
        agent: meta(),
        collectedAt: new Date().toISOString(),
        host: state.host,
        cpu: { ...state.cpu, history: state.cpuHistory.slice() },
        memory: state.memory,
        disks: diskInfo,
        network: { ...state.network, history: state.netHistory.slice() },
        services: serviceInfo,
        ports: portInfo,
        firewall: firewallInfo,
      };
    },
    async section(name) {
      await ready;
      const collectedAt = new Date().toISOString();
      if (name === 'host') return { collectedAt, ...state.host };
      if (name === 'cpu') return { collectedAt, ...state.cpu, history: state.cpuHistory.slice() };
      if (name === 'memory') return { collectedAt, ...state.memory };
      if (name === 'network') {
        return { collectedAt, ...state.network, history: state.netHistory.slice() };
      }
      if (name === 'disks') return { collectedAt, ...(await disks()) };
      if (name === 'services') return { collectedAt, ...(await services()) };
      if (name === 'ports') return { collectedAt, ...(await ports()) };
      if (name === 'firewall') return { collectedAt, ...(await firewall()) };
      return null;
    },
  };
}
