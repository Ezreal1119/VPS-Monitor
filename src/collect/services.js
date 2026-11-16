import { firstLine, run } from '../exec.js';

export function parseUnits(text) {
  const units = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^●\s+/, '').trim();
    if (!line || line.startsWith('UNIT ') || line.startsWith('Load State')) continue;
    const [name, , , sub, ...rest] = line.split(/\s+/);
    if (!name || !name.endsWith('.service')) continue;
    units.push({
      name,
      state: sub || '',
      description: rest.join(' '),
    });
  }
  return units;
}

async function listUnits(state) {
  const plain = ['list-units', '--type=service', `--state=${state}`, '--no-legend', '--plain', '--no-pager'];
  let result = await run('systemctl', plain);
  if (!result.ok && !result.missing) {
    result = await run('systemctl', ['list-units', '--type=service', `--state=${state}`, '--no-legend', '--no-pager']);
  }
  return result;
}

export async function collectServices() {
  const empty = {
    available: false,
    systemState: '',
    runningCount: 0,
    failedCount: 0,
    running: [],
    failed: [],
    note: '',
  };

  if (process.platform !== 'linux') {
    return { ...empty, note: 'Services are collected only on Linux (systemd).' };
  }

  const [running, failed, state] = await Promise.all([
    listUnits('running'),
    listUnits('failed'),
    run('systemctl', ['is-system-running']),
  ]);

  if (running.missing || failed.missing) {
    return { ...empty, note: 'systemctl was not found.' };
  }

  const runningUnits = parseUnits(running.stdout);
  const failedUnits = parseUnits(failed.stdout);
  const note = running.ok || running.stdout ? '' : (firstLine(running.stderr) || 'systemctl failed');

  return {
    available: true,
    systemState: (state.stdout || '').trim(),
    runningCount: runningUnits.length,
    failedCount: failedUnits.length,
    running: runningUnits,
    failed: failedUnits,
    note,
  };
}
