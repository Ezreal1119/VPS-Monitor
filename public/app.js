const TOKEN_KEY = 'vps-monitor-token';
const SVG_NS = 'http://www.w3.org/2000/svg';

let token = sessionStorage.getItem(TOKEN_KEY) || '';
let loading = false;
let authOpen = false;
let latest = null;

const ACTION = { allow: '放行', deny: '拒绝', limit: '限制' };
const SYSTEM_STATE = {
  running: '系统正常',
  degraded: '有服务失败，系统处于降级',
  maintenance: '维护中',
  starting: '启动中',
  stopping: '关闭中',
  offline: '离线',
};

document.getElementById('token-form').addEventListener('submit', (event) => {
  event.preventDefault();
  token = document.getElementById('token-input').value.trim();
  sessionStorage.setItem(TOKEN_KEY, token);
  document.getElementById('token-error').textContent = '';
  load();
});

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === 'class') {
      if (value) node.className = value;
    } else if (value != null) node.setAttribute(key, value);
  }
  for (const child of children || []) {
    if (child instanceof Node) node.append(child);
    else node.append(document.createTextNode(child == null ? '' : String(child)));
  }
  return node;
}

function formatBytes(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Number(value);
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const digits = size >= 100 || index === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)}\u00A0${units[index]}`;
}

function formatRate(value) {
  if (value == null) return '—';
  return `${formatBytes(value)}/s`;
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分`;
}

function level(percent) {
  if (percent >= 90) return 'bad';
  if (percent >= 75) return 'warn';
  return 'ok';
}

function metric(value, unit) {
  const node = document.createElement('span');
  node.append(document.createTextNode(value));
  if (unit) {
    const small = document.createElement('small');
    small.textContent = unit;
    node.append(small);
  }
  return node;
}

function stat(label, value, sub, percent, tone) {
  const card = el('article', { class: `stat ${tone || (percent == null ? '' : level(percent))}` });
  card.append(el('p', { class: 'k' }, [label]));
  card.append(el('p', { class: 'v' }, [value]));
  card.append(el('p', { class: 's' }, [sub || '']));
  if (percent != null && Number.isFinite(percent)) {
    const bar = el('div', { class: 'bar' });
    const fill = document.createElement('span');
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    bar.append(fill);
    card.append(bar);
  }
  return card;
}

function table(columns, rows, emptyText) {
  const wrap = el('div', { class: 'table-wrap' });
  const view = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of columns) headRow.append(el('th', { class: column.num ? 'num' : '' }, [column.label]));
  head.append(headRow);
  const body = document.createElement('tbody');
  if (!rows.length) {
    const row = document.createElement('tr');
    row.append(el('td', { class: 'empty', colspan: String(columns.length) }, [emptyText || '没有数据']));
    body.append(row);
  } else {
    for (const item of rows) {
      const row = document.createElement('tr');
      if (item._class) row.className = item._class;
      for (const column of columns) {
        row.append(el('td', { class: column.num ? 'num' : '' }, [column.value(item)]));
      }
      body.append(row);
    }
  }
  view.append(head, body);
  wrap.append(view);
  return wrap;
}

function replaceSection(id, title, note, node) {
  const root = document.getElementById(id);
  const previous = root.querySelector('.table-wrap');
  const scrollTop = previous ? previous.scrollTop : 0;
  const children = [el('h2', {}, [title])];
  if (note) children.push(el('p', { class: 'note' }, [note]));
  if (node) children.push(node);
  root.replaceChildren(...children);
  const next = root.querySelector('.table-wrap');
  if (next) next.scrollTop = scrollTop;
}

function sparkline(series, scale) {
  const width = 320;
  const height = 72;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  const values = series.flatMap((item) => item.values).filter((value) => value != null);
  if (values.length < 2) return svg;
  const low = scale.min ?? Math.min(...values, 0);
  const high = scale.max ?? Math.max(...values, 1);
  const span = high - low || 1;
  for (const item of series) {
    if (item.values.length < 2) continue;
    const points = item.values.map((value, index) => {
      const safe = value == null ? low : value;
      const x = (index / (item.values.length - 1)) * (width - 4) + 2;
      const y = height - 4 - ((safe - low) / span) * (height - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', points);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', item.color);
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('stroke-linecap', 'round');
    svg.append(line);
  }
  return svg;
}

function addresses(list) {
  const v4 = (list || []).filter((item) => item.family === 'ipv4').map((item) => item.address);
  const v6 = (list || []).filter((item) => item.family === 'ipv6').map((item) => item.address);
  return [...v4, ...v6].join('  ') || '—';
}

function usageCell(percent) {
  const wrap = el('div', { class: 'usage' });
  wrap.append(document.createTextNode(`${percent}%`));
  const bar = el('div', { class: 'bar' });
  const fill = document.createElement('span');
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  bar.append(fill);
  wrap.append(bar);
  return wrap;
}

function serviceName(name) {
  return name.endsWith('.service') ? name.slice(0, -8) : name;
}

function showAuth(message) {
  authOpen = true;
  document.getElementById('boot').classList.add('hidden');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('auth').classList.remove('hidden');
  document.getElementById('token-error').textContent = message || '';
  if (token && !document.getElementById('token-input').value) {
    document.getElementById('token-input').value = token;
  }
}

function showApp() {
  authOpen = false;
  document.getElementById('boot').classList.add('hidden');
  document.getElementById('auth').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

function render(data) {
  latest = data;
  showApp();
  const host = data.host || {};
  document.title = host.hostname ? `${host.hostname} · VPS Monitor` : 'VPS Monitor';
  document.getElementById('hostname').textContent = host.hostname || '—';
  const speed = host.cpuSpeedMhz ? ` · ${host.cpuSpeedMhz} MHz` : '';
  document.getElementById('identity').textContent = [
    host.distro,
    host.kernel,
    host.arch,
    host.uptimeSeconds != null ? `开机 ${formatUptime(host.uptimeSeconds)}` : '',
  ].filter(Boolean).join(' · ') + (host.cpuModel ? ` · ${host.cpuModel}${speed}` : '');

  const pills = document.getElementById('pills');
  pills.replaceChildren();
  const age = Math.max(0, Math.round((Date.now() - Date.parse(data.collectedAt)) / 1000));
  pills.append(el('div', { class: 'pill ok' }, [
    el('span', { class: 'dot' }),
    el('span', { id: 'pill-text' }, [age < 2 ? '在线 · 刚刚更新' : `在线 · ${age} 秒前`]),
  ]));
  if (data.services?.systemState === 'degraded') {
    pills.append(el('div', { class: 'pill bad' }, [el('span', { class: 'dot' }), '服务异常']));
  }

  const banner = document.getElementById('banner');
  const messages = [];
  if (data.agent?.platform && data.agent.platform !== 'linux') {
    messages.push('当前不是 Linux。服务和防火墙要到 VPS 上才有完整数据，其余几项可以在这台机器上先看。');
  }
  const listenHost = String(data.agent?.listen || '').split(':')[0];
  const loopback = listenHost === '127.0.0.1' || listenHost === 'localhost' || listenHost === '::1';
  if (data.agent && data.agent.auth === false && !loopback) {
    messages.push('没有设置 MONITOR_TOKEN，而且没有只听本机。先把令牌加上，再对外监听。');
    banner.className = 'banner bad';
  } else {
    banner.className = 'banner';
  }
  banner.textContent = messages.join(' ');
  banner.classList.toggle('hidden', messages.length === 0);

  renderMetrics(data);
  renderCharts(data);
  renderDisks(data.disks);
  renderNetwork(data.network);
  renderServices(data.services);
  renderPorts(data.ports);
  renderFirewall(data.firewall);

  const foot = [];
  if (data.agent?.version) foot.push(`v${data.agent.version}`);
  if (data.agent?.listen) foot.push(`监听 ${data.agent.listen}`);
  foot.push(data.agent?.auth ? '已要求访问令牌' : '未设置访问令牌');
  document.getElementById('foot').textContent = foot.join(' · ');
}

function renderMetrics(data) {
  const memory = data.memory || {};
  const disks = data.disks?.mounts || [];
  const rootDisk = disks.find((item) => item.mount === '/') || disks[0];
  const services = data.services || {};
  const load = data.host?.load || [];
  const cpuCount = data.host?.cpuCount || 1;
  const loadTone = load[0] > cpuCount ? 'warn' : 'ok';
  const failed = services.failedCount || 0;

  const root = document.getElementById('metrics');
  root.replaceChildren(
    stat('CPU', metric(String(data.cpu?.usagePercent ?? '—'), '%'), `${cpuCount} 核`, data.cpu?.usagePercent),
    stat(
      '内存',
      metric(formatBytes(memory.used), ''),
      memory.total
        ? `共 ${formatBytes(memory.total)}\n可用 ${formatBytes(memory.available)}${memory.swapTotal ? `\nswap ${formatBytes(memory.swapUsed)}` : ''}`
        : '',
      memory.usedPercent,
    ),
    stat(
      '磁盘',
      metric(rootDisk ? `${rootDisk.usedPercent}` : '—', rootDisk ? '%' : ''),
      rootDisk ? `${rootDisk.mount}\n可用 ${formatBytes(rootDisk.available)}` : (data.disks?.note || ''),
      rootDisk ? rootDisk.usedPercent : null,
    ),
    stat('负载', metric(load.length ? String(load[0]) : '—'), `5 分 ${load[1] ?? '—'} · 15 分 ${load[2] ?? '—'}`, null, loadTone),
    stat(
      '服务',
      metric(services.available ? String(services.runningCount) : '—', services.available ? '运行' : ''),
      services.available ? (failed ? `${failed} 个失败` : '没有失败的服务') : '仅 Linux',
      null,
      services.available ? (failed ? 'bad' : 'ok') : '',
    ),
    stat(
      '监听',
      metric(data.ports?.available ? String(data.ports.count) : '—'),
      data.ports?.available ? '个端口' : (data.ports?.note || ''),
    ),
  );
}

function renderCharts(data) {
  const cpuHistory = (data.cpu?.history || []).map((item) => item.usagePercent);
  const cpuCard = el('article', { class: 'chart' });
  cpuCard.append(el('h2', {}, ['CPU']));
  cpuCard.append(sparkline([{ color: '#d6f25c', values: cpuHistory }], { min: 0, max: 100 }));
  const cores = data.cpu?.cores || [];
  if (cores.length > 0 && cores.length <= 32) {
    const bars = el('div', { class: 'cores' });
    for (const core of cores) {
      const column = el('div', { class: 'core' });
      const fill = document.createElement('span');
      fill.style.height = `${Math.max(2, Math.min(100, core.usagePercent || 0))}%`;
      column.append(fill);
      bars.append(column);
    }
    cpuCard.append(bars);
  } else if (cores.length > 32) {
    cpuCard.append(el('p', { class: 'note' }, [`${cores.length} 核，图上只保留总使用率。`]));
  }
  if (cpuHistory.length < 2) cpuCard.append(el('p', { class: 'note' }, ['采样中']));

  const netHistory = data.network?.history || [];
  const netCard = el('article', { class: 'chart' });
  netCard.append(el('h2', {}, ['网络']));
  netCard.append(sparkline([
    { color: '#8fd18a', values: netHistory.map((item) => item.rxRate) },
    { color: '#e6b15c', values: netHistory.map((item) => item.txRate) },
  ], { min: 0 }));
  const legend = el('p', { class: 'legend' });
  legend.append(el('span', {}, [el('i', { class: 'swatch', style: 'background:#8fd18a' }), `接收 ${formatRate(data.network?.rxRate)}`]));
  legend.append(el('span', {}, [el('i', { class: 'swatch', style: 'background:#e6b15c' }), `发送 ${formatRate(data.network?.txRate)}`]));
  netCard.append(legend);
  if (netHistory.length < 2) netCard.append(el('p', { class: 'note' }, ['采样中']));

  document.getElementById('charts').replaceChildren(cpuCard, netCard);
}

function renderDisks(disks) {
  const rows = (disks?.mounts || []).map((item) => ({ ...item }));
  replaceSection(
    'disks',
    '磁盘',
    disks?.note || '',
    disks?.available === false ? null : table([
      { label: '挂载', value: (row) => row.mount },
      { label: '文件系统', value: (row) => row.filesystem },
      { label: '类型', value: (row) => row.type || '—' },
      { label: '已用', num: true, value: (row) => formatBytes(row.used) },
      { label: '可用', num: true, value: (row) => formatBytes(row.available) },
      { label: '总量', num: true, value: (row) => formatBytes(row.total) },
      { label: '使用率', num: true, value: (row) => usageCell(row.usedPercent) },
    ], rows, '没有看到磁盘'),
  );
}

function renderNetwork(network) {
  const rows = (network?.interfaces || []).map((item) => ({ ...item }));
  replaceSection(
    'network',
    '网络',
    '',
    table([
      { label: '网卡', value: (row) => row.name },
      { label: '地址', value: (row) => addresses(row.addresses) },
      { label: '接收', num: true, value: (row) => formatBytes(row.rxBytes) },
      { label: '发送', num: true, value: (row) => formatBytes(row.txBytes) },
      { label: '接收速率', num: true, value: (row) => formatRate(row.rxRate) },
      { label: '发送速率', num: true, value: (row) => formatRate(row.txRate) },
    ], rows, '没有看到网卡'),
  );
}

function renderServices(services) {
  const note = [
    services?.systemState ? (SYSTEM_STATE[services.systemState] || services.systemState) : '',
    services?.note || '',
  ].filter(Boolean).join(' · ');
  const failed = (services?.failed || []).map((item) => ({ ...item, _class: 'bad' }));
  const running = services?.running || [];
  const columns = [
    { label: '服务', value: (row) => serviceName(row.name) },
    { label: '状态', value: (row) => row.state || '—' },
    { label: '说明', value: (row) => row.description || '—' },
  ];
  const block = document.createElement('div');
  if (services?.available !== false) {
    if (failed.length) {
      block.append(el('h2', {}, ['失败']));
      block.append(table(columns, failed));
    }
    block.append(el('h2', {}, [`运行中 · ${services?.runningCount ?? running.length}`]));
    block.append(table(columns, running, '没有正在运行的服务'));
  }
  replaceSection('services', '服务', note, services?.available === false ? null : block);
}

function renderPorts(ports) {
  const rows = (ports?.listeners || []).map((item) => ({
    ...item,
    processText: item.process ? `${item.process}${item.pid ? ` · ${item.pid}` : ''}` : '—',
  }));
  replaceSection(
    'ports',
    '端口监听',
    ports?.note || '',
    ports?.available === false ? null : table([
      { label: '协议', value: (row) => row.proto },
      { label: '地址', value: (row) => row.address },
      { label: '端口', num: true, value: (row) => String(row.port) },
      { label: '进程', value: (row) => row.processText },
    ], rows, '没有监听端口'),
  );
}

function renderFirewall(firewall) {
  const bits = [firewall?.summary || '', firewall?.note || ''];
  if (firewall?.truncated) bits.push('只显示前 80 条。');
  const rows = (firewall?.rules || []).map((rule) => ({
    ...rule,
    _class: rule.action === 'deny' ? 'bad' : '',
    actionText: ACTION[rule.action] || rule.action || '—',
    protoText: [rule.proto || '—', rule.family === 'ipv6' ? 'v6' : ''].filter(Boolean).join(' · '),
  }));
  replaceSection(
    'firewall',
    '防火墙',
    bits.filter(Boolean).join(' '),
    firewall?.available === false ? null : table([
      { label: '动作', value: (row) => row.actionText },
      { label: '协议', value: (row) => row.protoText },
      { label: '端口', value: (row) => row.port || '—' },
      { label: '来源', value: (row) => row.from || '—' },
    ], rows, firewall?.enabled === false ? '没有启用的规则' : '没有读到规则'),
  );
}

function markDown() {
  const pill = document.getElementById('pill-text');
  if (!pill) return;
  const parent = pill.closest('.pill');
  if (parent) parent.className = 'pill bad';
  pill.textContent = '中断';
}

async function load() {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch('/api/overview', {
      cache: 'no-store',
      headers: token ? { 'x-monitor-token': token } : {},
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });
    if (response.status === 401) {
      showAuth(token ? '令牌不对' : '需要访问令牌');
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    if (latest) markDown();
    else {
      document.getElementById('boot').textContent = `读不到监控数据：${error.message}`;
    }
  } finally {
    loading = false;
  }
}

setInterval(() => {
  const pill = document.getElementById('pill-text');
  if (!latest || !pill || pill.textContent === '中断') return;
  const age = Math.max(0, Math.round((Date.now() - Date.parse(latest.collectedAt)) / 1000));
  pill.textContent = age < 2 ? '在线 · 刚刚更新' : `在线 · ${age} 秒前`;
}, 1000);

load();
setInterval(load, 3000);
