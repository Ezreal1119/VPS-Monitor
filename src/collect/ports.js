import { firstLine, run } from '../exec.js';

export function decodeCommand(value) {
  if (!value || !value.includes('\\x')) return value;
  const bytes = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\' && value[index + 1] === 'x') {
      const hex = value.slice(index + 2, index + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 3;
        continue;
      }
    }
    const code = value.charCodeAt(index);
    if (code < 128) bytes.push(code);
    else bytes.push(...new TextEncoder().encode(value[index]));
  }
  return new TextDecoder().decode(Uint8Array.from(bytes)).replaceAll('\uFFFD', '');
}

function splitHostPort(local) {
  if (local.startsWith('[')) {
    const match = local.match(/^\[(.*)\]:(\d+)$/);
    if (!match) return null;
    return { address: match[1], port: Number(match[2]) };
  }
  const index = local.lastIndexOf(':');
  if (index <= 0) return null;
  const port = Number(local.slice(index + 1));
  if (!Number.isInteger(port)) return null;
  return { address: local.slice(0, index), port };
}

export function parseSs(text) {
  const listeners = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(tcp|udp)\s+\S+\s+\d+\s+\d+\s+(\S+)\s+\S+(?:\s+users:\(\((.*)\)\))?/);
    if (!match) continue;
    const host = splitHostPort(match[2]);
    if (!host) continue;
    const processMatch = match[3] ? match[3].match(/"([^"]+)",pid=(\d+)/) : null;
    listeners.push({
      proto: match[1],
      address: host.address,
      port: host.port,
      process: processMatch ? decodeCommand(processMatch[1]) : '',
      pid: processMatch ? Number(processMatch[2]) : null,
    });
  }
  return dedupe(listeners);
}

export function parseLsof(text) {
  const listeners = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.endsWith('(LISTEN)')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const proto = parts[parts.length - 3].toLowerCase();
    const local = parts[parts.length - 2];
    if (proto !== 'tcp' && proto !== 'udp') continue;
    const host = splitHostPort(local);
    if (!host) continue;
    listeners.push({
      proto,
      address: host.address,
      port: host.port,
      process: decodeCommand(parts[0]),
      pid: Number(parts[1]) || null,
    });
  }
  return dedupe(listeners);
}

function dedupe(listeners) {
  const seen = new Set();
  const unique = [];
  for (const item of listeners) {
    const key = `${item.proto}|${item.address}|${item.port}|${item.pid || ''}|${item.process}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  unique.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto) || a.address.localeCompare(b.address));
  return unique.slice(0, 300);
}

export async function collectPorts() {
  if (process.platform === 'linux') {
    const result = await run('ss', ['-H', '-lntup']);
    if (result.missing) {
      return { available: false, count: 0, listeners: [], note: '没有找到 ss。' };
    }
    if (!result.ok && !result.stdout) {
      return { available: false, count: 0, listeners: [], note: firstLine(result.stderr) || 'ss 失败' };
    }
    const listeners = parseSs(result.stdout);
    const unnamed = listeners.length > 0 && listeners.every((item) => !item.process);
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    const note = unnamed && !isRoot ? '当前不是 root，看不到端口对应的进程名。' : '';
    return { available: true, count: listeners.length, listeners, note };
  }

  if (process.platform === 'darwin') {
    const result = await run('lsof', ['-nP', '+c', '0', '-iTCP', '-sTCP:LISTEN'], {
      env: { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
    });
    if (!result.ok && !result.stdout) {
      return { available: false, count: 0, listeners: [], note: firstLine(result.stderr) || 'lsof 失败' };
    }
    const listeners = parseLsof(result.stdout);
    return {
      available: true,
      count: listeners.length,
      listeners,
      note: '这是 macOS 的 TCP 监听。部署到 VPS 后改为 ss，并包含 UDP。',
    };
  }

  return { available: false, count: 0, listeners: [], note: '端口监听只在 Linux 上完整采集。' };
}
