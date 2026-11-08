process.env.HUB_QQ_OWNER ||= '10000000';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Enumerate only first-level project test files; never ask node:test to discover. */
export function discoverProjectTests(root = PROJECT_ROOT) {
  const directory = join(resolve(root), 'test');
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^.+\.test\.mjs$/i.test(entry.name))
    .map(entry => join(directory, entry.name))
    .sort();
}

const VALUE_OPTIONS = new Set([
  '--test-concurrency', '--test-coverage-branches', '--test-coverage-exclude', '--test-coverage-functions',
  '--test-coverage-include', '--test-coverage-lines', '--test-isolation', '--test-name-pattern',
  '--test-random-seed', '--test-reporter', '--test-reporter-destination', '--test-shard',
  '--test-skip-pattern', '--test-timeout',
]);
const FLAG_OPTIONS = new Set([
  '--experimental-test-coverage', '--experimental-test-module-mocks', '--test-force-exit',
  '--test-only', '--test-randomize', '--test-update-snapshots',
]);

/** Accept test-runner controls only; path arguments cannot widen the fixed file scope. */
export function validateTestOptions(args = []) {
  const accepted = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--' || arg === '--test' || arg === '--watch' || !arg.startsWith('--')) {
      throw new Error(`Unsupported test argument: ${arg}`);
    }
    const equalAt = arg.indexOf('=');
    const name = equalAt < 0 ? arg : arg.slice(0, equalAt);
    if (FLAG_OPTIONS.has(name)) {
      if (equalAt >= 0) throw new Error(`Test flag does not take a value: ${name}`);
      accepted.push(arg);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unsupported Node test option: ${name}`);
    if (equalAt >= 0) {
      if (equalAt === arg.length - 1) throw new Error(`Missing value for test option: ${name}`);
      accepted.push(arg);
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for test option: ${name}`);
    accepted.push(name, value);
    i += 1;
  }
  return accepted;
}

/** Keep validated Node test options before the explicit project file list. */
export function buildNodeTestArgs(files, forwardedArgs = []) {
  return ['--test', ...validateTestOptions(forwardedArgs), ...files];
}

function main() {
  const files = discoverProjectTests();
  if (files.length === 0) throw new Error(`No project tests found under ${join(PROJECT_ROOT, 'test')}`);
  const result = spawnSync(process.execPath, buildNodeTestArgs(files, process.argv.slice(2)), {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    console.error(`Node test runner terminated by ${result.signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(`Project test runner failed: ${String(error?.message || error)}`);
    process.exitCode = 1;
  }
}
