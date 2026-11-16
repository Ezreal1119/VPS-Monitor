import { firstLine, run } from '../exec.js';

const SKIP_TYPES = new Set([
  'tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'efivarfs', 'proc', 'sysfs',
  'cgroup2', 'cgroup', 'autofs', 'tracefs', 'securityfs', 'pstore', 'bpf',
  'debugfs', 'fusectl', 'configfs', 'mqueue', 'hugetlbfs', 'ramfs', 'devfs',
  'nsfs', 'rpc_pipefs', 'binfmt_misc',
]);

function mountRecord(fields) {
  return {
    filesystem: fields.filesystem,
    type: fields.type || '',
    mount: fields.mount,
    total: fields.total,
    used: fields.used,
    available: fields.available,
    usedPercent: fields.usedPercent,
  };
}

export function parseDfLinux(text) {
  const mounts = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    if (!match) continue;
    const type = match[2];
    const mount = match[7];
    if (mount !== '/' && SKIP_TYPES.has(type)) continue;
    mounts.push(mountRecord({
      filesystem: match[1],
      type,
      mount,
      total: Number(match[3]),
      used: Number(match[4]),
      available: Number(match[5]),
      usedPercent: Number(match[6]),
    }));
  }
  return sortMounts(mounts);
}

export function parseDfPosix(text, { scale = 1024, keep } = {}) {
  const mounts = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    if (!match) continue;
    const mount = match[6];
    if (keep && !keep(match[1], mount)) continue;
    mounts.push(mountRecord({
      filesystem: match[1],
      type: '',
      mount,
      total: Number(match[2]) * scale,
      used: Number(match[3]) * scale,
      available: Number(match[4]) * scale,
      usedPercent: Number(match[5]),
    }));
  }
  return sortMounts(mounts);
}

function sortMounts(mounts) {
  return mounts.sort((a, b) => {
    if (a.mount === '/') return -1;
    if (b.mount === '/') return 1;
    return a.mount.localeCompare(b.mount);
  });
}

function keepDarwinMount(filesystem, mount) {
  if (!filesystem.startsWith('/dev/')) return false;
  return mount === '/' || mount === '/System/Volumes/Data' || mount.startsWith('/Volumes/');
}

export async function collectDisks() {
  if (process.platform === 'linux') {
    const precise = await run('df', ['-PT', '-B1']);
    if (precise.ok) {
      return { available: true, mounts: parseDfLinux(precise.stdout), note: '' };
    }
    const fallback = await run('df', ['-P', '-k']);
    if (fallback.ok) {
      return {
        available: true,
        mounts: parseDfPosix(fallback.stdout, {
          scale: 1024,
          keep: (_filesystem, mount) => mount === '/' || !mount.startsWith('/run'),
        }),
        note: '',
      };
    }
    return { available: false, mounts: [], note: firstLine(precise.stderr || fallback.stderr) || 'df 失败' };
  }

  const result = await run('df', ['-P', '-k']);
  if (!result.ok) {
    return { available: false, mounts: [], note: firstLine(result.stderr) || 'df 失败' };
  }
  return {
    available: true,
    mounts: parseDfPosix(result.stdout, { scale: 1024, keep: keepDarwinMount }),
    note: '',
  };
}
