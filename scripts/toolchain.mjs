/**
 * Toolchain resolution for the build scripts.
 *
 * The adapter is built inside the upstream workspace, so it has to use the
 * toolchain that workspace pins: its `engines.node` floor and its
 * `packageManager` pnpm version. A developer shell may satisfy neither (a
 * system node one patch below the floor; corepack reaching for a pnpm newer
 * than the cache holds), so resolve both explicitly instead of trusting PATH.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** `engines.node` lower bound of the upstream workspace, e.g. "24.15.0". */
function enginesFloor(upstreamDir) {
  try {
    const range = JSON.parse(readFileSync(join(upstreamDir, 'package.json'), 'utf8')).engines?.node;
    const match = typeof range === 'string' ? /(\d+\.\d+\.\d+)/.exec(range) : null;
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** The pnpm version the upstream workspace pins, e.g. "10.33.0". */
function pinnedPnpm(upstreamDir) {
  try {
    const pinned = JSON.parse(readFileSync(join(upstreamDir, 'package.json'), 'utf8')).packageManager;
    return /^pnpm@(\d+\.\d+\.\d+)$/.exec(pinned ?? '')?.[1];
  } catch {
    return undefined;
  }
}

/** Every node under fnm, newest first. */
function installedNodes() {
  const root = join(homedir(), '.local', 'share', 'fnm', 'node-versions');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
    .map((name) => ({ version: name.slice(1), dir: join(root, name, 'installation', 'bin') }))
    .filter((entry) => existsSync(join(entry.dir, 'node')))
    .sort((left, right) => compareVersions(right.version, left.version));
}

/** The version `.nvmrc` pins, when it holds a concrete one. */
function nvmrcVersion(upstreamDir) {
  try {
    const raw = readFileSync(join(upstreamDir, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
    return /^\d+\.\d+\.\d+$/.test(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `bin` directory of the node to use, or undefined when the running node
 * is already the right one.
 *
 * `.nvmrc` wins when it is installed and satisfies the floor — the workspace
 * is developed and released on exactly that version. Otherwise the newest
 * installed version that satisfies `engines.node`.
 */
function resolveNodeDir(upstreamDir) {
  const required = enginesFloor(upstreamDir);
  if (required === undefined) return undefined;
  const wanted = nvmrcVersion(upstreamDir);
  const nodes = installedNodes();
  const pinned =
    wanted !== undefined && compareVersions(wanted, required) >= 0
      ? nodes.find((entry) => entry.version === wanted)
      : undefined;
  if (pinned !== undefined) {
    return pinned.version === process.versions.node ? undefined : pinned.dir;
  }
  if (compareVersions(process.versions.node, required) >= 0) return undefined;
  const suitable = nodes.find((entry) => compareVersions(entry.version, required) >= 0);
  if (suitable === undefined) {
    throw new Error(
      `the upstream workspace needs node >= ${required}; this shell runs ${process.versions.node} and no fnm node satisfies it`,
    );
  }
  return suitable.dir;
}

/**
 * How to run pnpm. Preference order:
 *   1. the corepack cache entry for the pinned version — offline, no prompt
 *   2. `pnpm` on PATH
 *   3. `corepack pnpm` (may download)
 */
function resolvePnpm(upstreamDir, nodeDir) {
  // pnpm refuses a project whose engines.node excludes the node running it, so
  // the resolved node also runs pnpm itself — not merely the child scripts.
  const node = nodeDir === undefined ? process.execPath : join(nodeDir, 'node');
  const pinned = pinnedPnpm(upstreamDir);
  if (pinned !== undefined) {
    const binary = join(homedir(), '.cache', 'node', 'corepack', 'v1', 'pnpm', pinned, 'bin', 'pnpm.cjs');
    if (existsSync(binary)) return { node, prefix: [binary], version: pinned, source: 'corepack-cache' };
  }
  return { node: 'pnpm', prefix: [], version: pinned, source: 'path' };
}

/**
 * Resolve node and pnpm for `upstreamDir`. Prepends the chosen node to this
 * process's PATH so child scripts (tsdown, postinstall) use it too.
 */
export function configureToolchain(upstreamDir) {
  const nodeDir = resolveNodeDir(upstreamDir);
  if (nodeDir !== undefined) {
    process.env['PATH'] = `${nodeDir}:${process.env['PATH'] ?? ''}`;
  }
  const pnpm = resolvePnpm(upstreamDir, nodeDir);
  const nodeVersion = nodeDir === undefined ? process.versions.node : readNodeVersion(nodeDir);
  return { nodeDir, pnpm, nodeVersion };
}

/**
 * `--store-dir` override, from `KIMI_PNPM_STORE_DIR`.
 *
 * A warm store turns the install into hardlinks; pointing it at an existing
 * store for the same tag is the difference between a minute and an hour on a
 * slow link. Unset means pnpm's own default.
 */
export function pnpmStoreArgs() {
  const storeDir = process.env['KIMI_PNPM_STORE_DIR'];
  return storeDir === undefined || storeDir.length === 0 ? [] : ['--store-dir', storeDir];
}

function readNodeVersion(nodeDir) {
  try {
    return execFileSync(join(nodeDir, 'node'), ['-v'], { encoding: 'utf8' }).trim().replace(/^v/, '');
  } catch {
    return process.versions.node;
  }
}

/** Run pnpm with the resolved toolchain, inheriting stdio. */
export function runPnpm(toolchain, args, options = {}) {
  const { node, prefix } = toolchain.pnpm;
  const shown = [node === process.execPath ? 'node' : node, ...prefix, ...args].join(' ');
  process.stderr.write(`[pnpm] ${shown}\n`);
  return execFileSync(node, [...prefix, ...args], { stdio: 'inherit', ...options });
}