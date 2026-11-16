export function round1(value) {
  return Math.round(value * 10) / 10;
}

function coreUsage(previous, next) {
  const keys = ['user', 'nice', 'sys', 'idle', 'irq'];
  let idle = 0;
  let total = 0;
  for (const key of keys) {
    const delta = (next[key] || 0) - (previous[key] || 0);
    total += delta;
    if (key === 'idle') idle = delta;
  }
  if (total <= 0) return 0;
  return (1 - idle / total) * 100;
}

export function diffCpus(previous, next) {
  if (!previous || previous.length !== next.length || next.length === 0) {
    return {
      usagePercent: 0,
      cores: next.map(() => ({ usagePercent: 0 })),
    };
  }

  const cores = next.map((cpu, index) => ({
    usagePercent: round1(coreUsage(previous[index].times, cpu.times)),
  }));
  const usagePercent = round1(
    cores.reduce((sum, core) => sum + core.usagePercent, 0) / cores.length,
  );
  return { usagePercent, cores };
}
