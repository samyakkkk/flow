// Shared by setup and service-side agent discovery. Never source shell profiles.
import { accessSync, constants, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const validName = name => /^[a-zA-Z0-9_-]+$/.test(name);
export function executableFile(file) {
  try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; }
}
function cacheFile(command, home) { return path.join(home, '.flow', 'executables', command + '.json'); }
export function rememberExecutable(command, file, { home = homedir() } = {}) {
  if (!validName(command) || !path.isAbsolute(file) || !executableFile(file)) return;
  const destination = cacheFile(command, home), temp = destination + '.' + randomUUID();
  try {
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify({ path: file }) + '\n', { mode: 0o600 });
    renameSync(temp, destination);
  } catch { try { unlinkSync(temp); } catch {} } // Read-only homes must still work.
}
export function executableCandidates(command, { home = homedir(), env = process.env, platform = process.platform, accept = () => true } = {}) {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) return executableFile(command) && accept(command) ? [command] : [];
  if (!validName(command)) return [];
  const names = platform === 'win32' ? [command, ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean).map(ext => command + ext)] : [command];
  const candidates = dirs => [...new Set(dirs.filter(dir => path.isAbsolute(dir)).flatMap(dir => names.map(name => path.join(dir, name))))].filter(file => executableFile(file) && accept(file));
  // Keep explicit PATH selection/version ranking when available. Recover from a
  // minimal service PATH using the last selection, then standard install locations.
  const onPath = candidates((env.PATH ?? '').split(path.delimiter));
  if (onPath.length) return onPath;
  try {
    const saved = JSON.parse(readFileSync(cacheFile(command, home), 'utf8')).path;
    if (typeof saved === 'string' && path.isAbsolute(saved) && executableFile(saved) && accept(saved)) return [saved];
  } catch {}
  const dirs = [path.join(home, '.local', 'bin'), path.join(home, '.opencode', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.claude', 'local'), '/usr/local/bin', '/opt/homebrew/bin'];
  const nvm = path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node');
  try { for (const version of readdirSync(nvm).filter(v => /^v\d+\.\d+\.\d+$/.test(v)).slice(0,100)) dirs.push(path.join(nvm, version, 'bin')); } catch {}
  if (platform === 'win32' && env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
  return candidates(dirs);
}
export function discoverExecutable(command, options = {}) {
  const file = executableCandidates(command, options)[0] ?? null;
  if (file) rememberExecutable(command, file, options);
  return file;
}
