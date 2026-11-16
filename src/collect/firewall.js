import { firstLine, run } from '../exec.js';

const MAX_RULES = 80;
const SECURITY_GROUP = '阿里云入站一般由安全组控制，安全组不在这台机器上，这一版不采集。';

function pack(partial) {
  const rules = partial.rules || [];
  const truncated = rules.length > MAX_RULES;
  return {
    available: partial.available ?? true,
    backend: partial.backend ?? 'none',
    enabled: partial.enabled ?? false,
    summary: partial.summary || '',
    rules: rules.slice(0, MAX_RULES),
    truncated,
    note: partial.note || '',
  };
}

export function isDenied(result) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  return /permission denied|you need to be root|operation not permitted|must be root|a password is required|superuser|not running as root/i.test(text);
}

function denied(backend, result) {
  return pack({
    backend,
    enabled: null,
    summary: `检测到 ${backend}，但当前进程没有权限读取规则。用 root 跑这个服务即可。`,
    note: firstLine(result.stderr || result.stdout),
  });
}

function normalizeAction(action) {
  const value = action.toLowerCase();
  if (value.startsWith('allow') || value === 'accept') return 'allow';
  if (value.startsWith('deny') || value.startsWith('reject') || value === 'drop') return 'deny';
  if (value.startsWith('limit')) return 'limit';
  return value.split(/\s+/)[0] || value;
}

export function parseUfwStatus(text) {
  const status = ((text.match(/^Status:\s*(\w+)/m) || [])[1] || '').toLowerCase();
  const enabled = status === 'active';
  const rules = [];
  if (enabled) {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || /^Status:/.test(line) || /^To\s+/.test(line) || /^--/.test(line)) continue;
      if (/^(Logging|Default):/.test(line)) continue;
      const parts = line.split(/\s{2,}/);
      if (parts.length < 3) continue;
      const target = parts[0].replace(/\s*\(v6\)\s*$/i, '').trim();
      const portMatch = target.match(/^(.*)\/(tcp|udp)$/i);
      rules.push({
        action: normalizeAction(parts[1]),
        proto: portMatch ? portMatch[2].toLowerCase() : '',
        port: portMatch ? portMatch[1] : target,
        from: parts.slice(2).join(' ').replace(/\s*\(v6\)\s*$/i, '').trim(),
      });
    }
  }
  return pack({
    backend: 'ufw',
    enabled,
    summary: enabled
      ? `ufw 已启用，${rules.length} 条规则。`
      : `ufw 已安装，但没有启用。${SECURITY_GROUP}`,
    rules,
  });
}

function listField(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm'));
  if (!match) return [];
  return match[1].trim().split(/\s+/).filter(Boolean);
}

export function parseFirewalldListAll(text) {
  const zone = (text.trim().match(/^(\S+)/) || [])[1] || 'public';
  const rules = [
    ...listField(text, 'services').map((name) => ({
      action: 'allow',
      proto: 'service',
      port: name,
      from: zone,
    })),
    ...listField(text, 'ports').map((entry) => {
      const [port, proto] = entry.split('/');
      return { action: 'allow', proto: proto || '', port: port || entry, from: zone };
    }),
  ];
  const note = /^\s*rule\s+family=/m.test(text) ? '还有 rich rules，这一版没有展开。' : '';
  return pack({
    backend: 'firewalld',
    enabled: true,
    summary: `firewalld 正在运行，区域 ${zone}。`,
    rules,
    note,
  });
}

export function parseNft(text) {
  let hook = '';
  let inputPolicy = '';
  const rules = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^chain\s+/.test(line) && !/hook/.test(line)) hook = '';
    const hookMatch = line.match(/hook\s+(input|forward|output)/i);
    if (hookMatch) hook = hookMatch[1].toLowerCase();
    const policyMatch = line.match(/policy\s+(accept|drop|reject)/i);
    if (policyMatch && hook === 'input') inputPolicy = policyMatch[1].toLowerCase();
    const ruleMatch = line.match(/\b(tcp|udp)\s+dport\s+(\{[^}]+\}|\d+)\s+(accept|drop|reject)\b/i);
    if (ruleMatch && hook === 'input') {
      rules.push({
        action: normalizeAction(ruleMatch[3]),
        proto: ruleMatch[1].toLowerCase(),
        port: ruleMatch[2].replace(/[{}]/g, '').trim(),
        from: 'anywhere',
      });
    }
  }
  const enabled = inputPolicy === 'drop' || inputPolicy === 'reject' || rules.some((rule) => rule.action === 'deny');
  const summary = inputPolicy
    ? `nftables 入站策略是 ${inputPolicy}。`
    : '检测到 nftables 规则。';
  return pack({ backend: 'nftables', enabled, summary, rules });
}

export function parseIptables(text, family) {
  let policy = '';
  const rules = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const policyMatch = line.match(/^-P\s+INPUT\s+(\S+)/);
    if (policyMatch) {
      policy = policyMatch[1].toUpperCase();
      continue;
    }
    const ruleMatch = line.match(/^-A\s+INPUT\s*(.*?)\s+-j\s+(\S+)\s*$/);
    if (!ruleMatch) continue;
    const rest = ruleMatch[1];
    const action = normalizeAction(ruleMatch[2]);
    if (/\s-i\s+lo(\s|$)/.test(` ${rest} `)) continue;
    const proto = ((rest.match(/(?:^|\s)-p\s+(\S+)/) || [])[1] || '').toLowerCase();
    const port = (rest.match(/--dports?\s+(\S+)/) || [])[1] || '';
    const from = (rest.match(/(?:^|\s)-s\s+(\S+)/) || [])[1] || 'anywhere';
    if (!port && action === 'allow') continue;
    rules.push({
      action,
      proto,
      port: port || '全部',
      from,
      family,
    });
  }
  return { policy, rules };
}

async function fromIptables() {
  const v4 = await run('iptables', ['-S']);
  if (v4.missing) return null;
  if (isDenied(v4) || v4.timedOut) return denied('iptables', v4);
  if (!v4.ok && !v4.stdout) {
    return pack({
      backend: 'iptables',
      enabled: null,
      summary: '读取 iptables 失败。',
      note: firstLine(v4.stderr),
    });
  }
  const v6 = await run('ip6tables', ['-S']);
  const parsed4 = v4.ok || v4.stdout ? parseIptables(v4.stdout, 'ipv4') : { policy: '', rules: [] };
  const parsed6 = v6.ok || v6.stdout ? parseIptables(v6.stdout, 'ipv6') : { policy: '', rules: [] };
  const rules = [...parsed4.rules, ...parsed6.rules];
  const policies = [parsed4.policy, parsed6.policy].filter(Boolean);
  const enabled = policies.some((item) => item !== 'ACCEPT') || rules.some((rule) => rule.action === 'deny');
  const summary = policies.length
    ? `iptables INPUT 策略是 ${policies.join(' / ')}。`
    : '检测到 iptables。';
  return pack({
    backend: 'iptables',
    enabled,
    summary: enabled ? summary : `${summary} 没有额外拦截。${SECURITY_GROUP}`,
    rules,
  });
}

export async function collectFirewall() {
  if (process.platform !== 'linux') {
    return pack({
      available: false,
      summary: '防火墙只在 Linux 上采集。',
    });
  }

  const ufw = await run('ufw', ['status']);
  if (!ufw.missing) {
    if (isDenied(ufw)) return denied('ufw', ufw);
    if (ufw.timedOut) return pack({ backend: 'ufw', enabled: null, summary: '读取 ufw 超时。' });
    return parseUfwStatus(`${ufw.stdout}\n${ufw.stderr}`);
  }

  const firewalld = await run('firewall-cmd', ['--state']);
  if (!firewalld.missing) {
    if (isDenied(firewalld)) return denied('firewalld', firewalld);
    const running = firewalld.stdout.trim() === 'running';
    if (!running) {
      return pack({
        backend: 'firewalld',
        enabled: false,
        summary: `firewalld 已安装，但没有运行。${SECURITY_GROUP}`,
      });
    }
    const list = await run('firewall-cmd', ['--list-all']);
    if (isDenied(list)) return denied('firewalld', list);
    return parseFirewalldListAll(list.stdout);
  }

  const nft = await run('nft', ['list', 'ruleset']);
  if (!nft.missing) {
    if (isDenied(nft)) return denied('nftables', nft);
    if (nft.stdout.trim()) return parseNft(nft.stdout);
  }

  const iptables = await fromIptables();
  if (iptables) return iptables;

  return pack({
    backend: 'none',
    enabled: false,
    summary: `没有检测到 ufw、firewalld、nftables 或 iptables。${SECURITY_GROUP}`,
  });
}
