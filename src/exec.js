import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 4000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `/usr/sbin:/usr/bin:/sbin:/bin:${process.env.PATH || ''}`,
        LANG: 'C',
        LC_ALL: 'C',
        ...options.env,
      },
    });
    return { ok: true, stdout: stdout || '', stderr: stderr || '', missing: false, timedOut: false };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || '',
      missing: error.code === 'ENOENT',
      timedOut: error.killed === true || error.code === 'ERR_TIMED_OUT',
    };
  }
}

export function firstLine(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
}
