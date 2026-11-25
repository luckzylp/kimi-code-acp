#!/usr/bin/env node
/**
 * Produce the installable artifact and the npx-cache tree (ADR 0001, M0/M1).
 *
 * The bundle is self-contained (the engine and the SDK are compiled into
 * `dist/main.mjs`), so the package has no runtime dependencies to resolve:
 * installing it writes one directory under `node_modules/@moonshot-ai/` plus
 * the `.bin` shim.
 *
 *   build/npm-package/                     staging package that `npm pack` reads
 *   build/moonshot-ai-kimi-code-acp-*.tgz  the publishable tarball
 *   build/npx-cache/npx/kimi-acp/          package.json + package-lock.json + node_modules
 *
 * The last directory is the shape Zed keeps for an npx agent (a `package.json`
 * pinning a version, the lockfile, and the installed tree), so it can be
 * dropped into a registry cache as-is.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { spawnAgent } from './lib/acp-client.mjs';
import { writeFakeHome } from './lib/fake-home.mjs';
import { configureToolchain } from './toolchain.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapterRoot = join(repoRoot, 'packages', 'kimi-acp');
const distMain = join(adapterRoot, 'dist', 'main.mjs');
const buildDir = join(repoRoot, 'build');
const stageDir = join(buildDir, 'npm-package');
const cacheDir = join(buildDir, 'npx-cache', 'npx', 'kimi-acp');

const NAME = '@moonshot-ai/kimi-code-acp';
const { version } = JSON.parse(readFileSync(join(adapterRoot, 'package.json'), 'utf8'));

function log(message) {
  process.stderr.write(`[pack] ${message}\n`);
}

const toolchain = configureToolchain(join(repoRoot, 'vendor', 'upstream'));
log(`node ${toolchain.nodeVersion}, npm ${toolchain.npm.node === 'npm' ? 'from PATH' : 'bundled with that node'}`);

function npm(args, options = {}) {
  process.stderr.write(`[pack] npm ${args.join(' ')}\n`);
  return execFileSync(toolchain.npm.node, [...toolchain.npm.prefix, ...args], { stdio: 'inherit', ...options });
}

if (!existsSync(distMain)) {
  process.stderr.write('[pack] dist/main.mjs missing — run `node scripts/build.mjs` first\n');
  process.exit(1);
}

// 1. Stage what a published package contains: the bundle, a README, a license.
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
mkdirSync(join(stageDir, 'dist'), { recursive: true });
cpSync(distMain, join(stageDir, 'dist', 'main.mjs'));
cpSync(join(repoRoot, 'README.md'), join(stageDir, 'README.md'));
cpSync(join(repoRoot, 'LICENSE'), join(stageDir, 'LICENSE'));

writeFileSync(
  join(stageDir, 'package.json'),
  `${JSON.stringify(
    {
      name: NAME,
      version,
      description: 'An independent ACP agent for kimi-code',
      license: 'MIT',
      type: 'module',
      bin: { 'kimi-acp': 'dist/main.mjs' },
      files: ['dist', 'README.md', 'LICENSE'],
      engines: { node: '>=24.15.0' },
    },
    null,
    2,
  )}\n`,
);
log(`staged ${NAME}@${version}`);

// 2. Pack it. The tarball is the unit a registry would serve.
npm(['pack', '--pack-destination', buildDir], { cwd: stageDir });
const tarball = join(buildDir, `moonshot-ai-kimi-code-acp-${version}.tgz`);
if (!existsSync(tarball)) {
  process.stderr.write(`[pack] expected tarball missing: ${tarball}\n`);
  process.exit(1);
}
log(`tarball ${tarball} (${(readFileSync(tarball).length / 1024 / 1024).toFixed(1)} MiB)`);

// 3. Install it the way a client would, into the npx-cache shape.
rmSync(cacheDir, { recursive: true, force: true });
mkdirSync(cacheDir, { recursive: true });
const spec = `file:${relative(cacheDir, tarball)}`;
writeFileSync(
  join(cacheDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'kimi-code-acp-cache',
      private: true,
      dependencies: { [NAME]: spec },
    },
    null,
    2,
  )}\n`,
);
npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', '--install-links'], { cwd: cacheDir });

// 4. Verify the installed tree actually runs and answers ACP.
const installedMain = join(cacheDir, 'node_modules', ...NAME.split('/'), 'dist', 'main.mjs');
if (!existsSync(installedMain)) {
  process.stderr.write(`[pack] installed main.mjs missing: ${installedMain}\n`);
  process.exit(1);
}
const versionOutput = execFileSync(process.execPath, [installedMain, '--version'], { encoding: 'utf8' }).trim();
log(`installed --version → ${versionOutput}`);

const homeDir = writeFakeHome();
const workDir = mkdtempSync(join(tmpdir(), 'kimi-acp-pack-'));
const agent = spawnAgent(installedMain, { homeDir });
try {
  const init = await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.request('session/new', { cwd: workDir, mcpServers: [] });
  if (init.protocolVersion !== 1 || typeof created.sessionId !== 'string') {
    throw new Error('installed agent failed the ACP handshake');
  }
  log(`installed handshake → protocolVersion ${init.protocolVersion}, session ${created.sessionId}`);
} finally {
  await agent.close();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
}

const entries = readFileSync(join(cacheDir, 'package-lock.json'), 'utf8').length;
log(`npx cache ready: ${cacheDir} (package.json, package-lock.json, node_modules; lockfile ${entries} bytes)`);