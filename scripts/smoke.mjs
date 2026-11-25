#!/usr/bin/env node
/**
 * M0 acceptance smoke: spawn the built bundle and speak ACP to it.
 *
 *   node scripts/smoke.mjs
 *
 * Checks, in order:
 *   1. the bundle runs (`--version`)
 *   2. it answers `initialize` with a protocol version we support
 *   3. it boots the engine and creates a real session for a temp workspace
 *   4. it shuts down when the client closes the pipe
 *
 * `session/prompt` is covered by `scripts/e2e.mjs`, which adds a fake
 * provider; this script must pass without any model or network.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnAgent } from './lib/acp-client.mjs';
import { writeFakeHome } from './lib/fake-home.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainPath = join(repoRoot, 'packages', 'kimi-acp', 'dist', 'main.mjs');

function fail(message) {
  process.stderr.write(`[smoke] FAIL ${message}\n`);
  process.exit(1);
}

function ok(message) {
  process.stderr.write(`[smoke] ok ${message}\n`);
}

async function checkVersion() {
  const output = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [mainPath, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', rejectPromise);
    child.on('close', (code) =>
      code === 0 ? resolvePromise(stdout.trim()) : rejectPromise(new Error(`exit ${code}`)),
    );
  });
  if (!/^kimi-acp \d+\.\d+\.\d+$/.test(output)) fail(`unexpected --version output: ${JSON.stringify(output)}`);
  ok(`--version → ${output}`);

  const help = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [mainPath, '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', rejectPromise);
    child.on('close', () => resolvePromise(stdout));
  });
  if (!help.includes('kimi-acp login')) fail('--help does not document the login command');
  ok('--help documents the login command');
}

async function checkHandshake() {
  const homeDir = writeFakeHome();
  const workDir = mkdtempSync(join(tmpdir(), 'kimi-acp-work-'));
  const agent = spawnAgent(mainPath, { homeDir, env: { KIMI_ACP_DEBUG: '1' } });
  try {
    const init = await agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { _meta: { terminal_output: true } },
    });
    if (init.protocolVersion !== 1) fail(`initialize returned protocolVersion ${init.protocolVersion}`);
    ok(`initialize → protocolVersion ${init.protocolVersion}`);

    const created = await agent.request('session/new', { cwd: workDir, mcpServers: [] });
    if (typeof created.sessionId !== 'string' || created.sessionId.length === 0) {
      fail('session/new returned no sessionId');
    }
    ok(`session/new → ${created.sessionId}`);
  } finally {
    await agent.close();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

await checkVersion();
await checkHandshake();
ok('M0 chain validated: tag → workspace → single-file bundle → engine session');