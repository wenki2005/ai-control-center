import { spawnSync as nodeSpawnSync } from 'node:child_process';

export const READ_ONLY_CUA_SOCKET = String.raw`\\.\pipe\Mornye-Readonly-CUA`;
export const INTERACTIVE_CUA_SOCKET = String.raw`\\.\pipe\Mornye-Interactive-CUA`;
// This is Cua Driver's normalized digest for the reviewed, repository-pinned
// manifest. A daemon on the default pipe or with a broader policy never passes.
export const READ_ONLY_CUA_EFFECTIVE_MANIFEST_SHA256 = 'ec8bd4499c81dcca214be8a076d86186290f518754215b3a5bcb8915fb26f9b2';
export const INTERACTIVE_CUA_EFFECTIVE_MANIFEST_SHA256 = '7b1c40d63412abad119ccb030385edc9038a4b4b12207723e835fd1c6a589829';

export function computerControlLaunchOptions({argv=[],env={},approvedMode=null}={}) {
  const args=Array.isArray(argv)?argv:[];
  const inline=args.find(value=>typeof value==='string'&&value.startsWith('--cua-executable='));
  const separateIndex=args.indexOf('--cua-executable');
  const explicitExecutable=inline?.slice('--cua-executable='.length)
    || (separateIndex>=0 && typeof args[separateIndex+1]==='string' ? args[separateIndex+1] : '');
  return {
    interactiveOptIn:args.includes('--interactive-computer-control')||env.MORNYE_CUA_INTERACTIVE==='1'||approvedMode==='interactive',
    executable:explicitExecutable||env.MORNYE_CUA_EXECUTABLE||'cua-driver',
  };
}

export function isReviewedReadOnlyCuaReady({ executable = 'cua-driver', pidFile, cwd, spawnSync = nodeSpawnSync } = {}) {
  if (typeof pidFile !== 'string' || typeof cwd !== 'string') return false;
  let result;
  try {
    result = spawnSync(executable, ['status', '--socket', READ_ONLY_CUA_SOCKET, '--pid-file', pidFile], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 2500, stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch { return false; }
  if (result?.error || result?.status !== 0 || typeof result.stdout !== 'string') return false;
  const output = result.stdout;
  return output.includes(`socket: ${READ_ONLY_CUA_SOCKET}`) &&
    /permission mode: bounded \(trusted_startup_configuration\)/i.test(output) &&
    /capability manifest: configured=true, approved_at_startup=true, valid=true/i.test(output) &&
    output.toLowerCase().includes(`capability manifest sha256: ${READ_ONLY_CUA_EFFECTIVE_MANIFEST_SHA256}`);
}

export function isReviewedInteractiveCuaReady({ executable = 'cua-driver', pidFile, cwd, spawnSync = nodeSpawnSync } = {}) {
  if (typeof pidFile !== 'string' || typeof cwd !== 'string') return false;
  let result;
  try {
    result = spawnSync(executable, ['status', '--socket', INTERACTIVE_CUA_SOCKET, '--pid-file', pidFile], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 2500, stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch { return false; }
  if (result?.error || result?.status !== 0 || typeof result.stdout !== 'string') return false;
  const output = result.stdout;
  return output.includes(`socket: ${INTERACTIVE_CUA_SOCKET}`) &&
    /permission mode: bounded \(trusted_startup_configuration\)/i.test(output) &&
    /capability manifest: configured=true, approved_at_startup=true, valid=true/i.test(output) &&
    output.toLowerCase().includes(`capability manifest sha256: ${INTERACTIVE_CUA_EFFECTIVE_MANIFEST_SHA256}`);
}
