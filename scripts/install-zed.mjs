#!/usr/bin/env node
/**
 * Install this adapter into Zed's npx registry directory for kimi-code.
 *
 *   node scripts/install-zed.mjs            # target: ~/.local/share/zed/external_agents/registry/npx/kimi-code
 *   node scripts/install-zed.mjs --target <dir>
 *   node scripts/install-zed.mjs --skip-build
 *
 * The directory keeps its npx-cache shape: package.json, package-lock.json and
 * node_modules/@moonshot-ai/kimi-code. Only the package's entry bundle
 * (dist/main.mjs) is replaced with ours; the original is kept next to it as
 * main.mjs.upstream so one cp reverts the install.
 */
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultTarget = join(
  homedir(),
  '.local',
  'share',
  'zed',
  'external_agents',
  'registry',
  'npx',
  'kimi-code',
);

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined) throw new Error(`${name} needs a value`);
  return value;
}

const target = resolve(argument('--target', defaultTarget));
const skipBuild = process.argv.includes('--skip-build');
const ourBundle = join(repoRoot, 'packages', 'kimi-acp', 'dist', 'main.mjs');
const packageDir = join(target, 'node_modules', '@moonshot-ai', 'kimi-code');
const targetBundle = join(packageDir, 'dist', 'main.mjs');

function fail(message) {
  process.stderr.write(`[zed] ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`))));
  });
}

async function verify() {
  const child = spawn(process.execPath, [targetBundle, 'acp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, KIMI_ACP_DEBUG: '' },
  });
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (output.includes('\n')) child.stdin.end();
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {} },
  })}\n`);

  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  await new Promise((resolvePromise) => child.on('exit', resolvePromise));
  clearTimeout(timeout);

  const line = output.split('\n').find((entry) => entry.trim().length > 0);
  if (line === undefined) fail(`the installed agent answered nothing${errors ? `: ${errors.slice(-400)}` : ''}`);
  let response;
  try {
    response = JSON.parse(line);
  } catch {
    fail(`the installed agent's first line is not JSON: ${line.slice(0, 200)}`);
  }
  if (response.result?.protocolVersion !== 1 || response.result?.agentCapabilities?.loadSession !== true) {
    fail(`unexpected handshake: ${JSON.stringify(response).slice(0, 400)}`);
  }
  return response.result;
}

if (!existsSync(join(target, 'package.json'))) {
  fail(`${target} is not an npx install (no package.json)`);
}
if (!existsSync(targetBundle)) {
  fail(`${target} has no node_modules/@moonshot-ai/kimi-code/dist/main.mjs`);
}

if (!skipBuild) {
  process.stderr.write('[zed] building the adapter…\n');
  // The build installs the adapter into the upstream workspace with pnpm; keep
  // an already-populated store so the sync also works offline.
  const storeDir =
    process.env['KIMI_PNPM_STORE_DIR'] ??
    (existsSync('/tmp/.pnpm-store/v10') ? '/tmp/.pnpm-store/v10' : undefined);
  await run(process.execPath, [join(repoRoot, 'scripts', 'build.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, ...(storeDir === undefined ? {} : { KIMI_PNPM_STORE_DIR: storeDir }) },
  });
}
if (!existsSync(ourBundle)) fail('no built bundle; run without --skip-build');
const bytes = statSync(ourBundle).size;

const upstreamBackup = `${targetBundle}.upstream`;
const previousBackup = `${targetBundle}.previous`;
if (!existsSync(upstreamBackup)) {
  copyFileSync(targetBundle, upstreamBackup);
  process.stderr.write(`[zed] kept the original bundle at ${upstreamBackup}\n`);
} else {
  copyFileSync(targetBundle, previousBackup);
}

copyFileSync(ourBundle, targetBundle);
chmodSync(targetBundle, 0o755);

const handshake = await verify();
process.stderr.write(
  `[zed] installed ${(bytes / 1024 / 1024).toFixed(1)} MiB into ${targetBundle}\n` +
    `[zed] handshake ok: protocol ${handshake.protocolVersion}, loadSession ${handshake.agentCapabilities.loadSession}\n` +
    `[zed] revert: cp ${upstreamBackup} ${targetBundle}\n`,
);