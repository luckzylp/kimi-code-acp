#!/usr/bin/env node
/**
 * M0 end-to-end: real engine turns over ACP, driven by a fake provider.
 *
 *   node scripts/e2e.mjs
 *
 * What it proves, beyond the handshake in `scripts/smoke.mjs`:
 *   - `session/prompt` reaches the engine as a run and settles once
 *   - assistant deltas arrive as coalesced `agent_message_chunk` updates that
 *     share one `messageId`
 *   - the response is answered after the turn (`end_turn`), not at submission
 *   - `session/cancel` reaches the run and settles it as `cancelled`
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnAgent } from './lib/acp-client.mjs';
import { writeFakeHome } from './lib/fake-home.mjs';
import { startFakeProvider } from './lib/fake-provider.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainPath = join(repoRoot, 'packages', 'kimi-acp', 'dist', 'main.mjs');

const REPLY = 'Hello from the fake provider.';

function fail(message) {
  process.stderr.write(`[e2e] FAIL ${message}\n`);
  process.exit(1);
}

function ok(message) {
  process.stderr.write(`[e2e] ok ${message}\n`);
}

/** Boot an agent with a fake provider and a throwaway home/work directory. */
async function withAgent(options, body) {
  const provider = await startFakeProvider(options);
  const homeDir = writeFakeHome({ baseUrl: provider.baseUrl });
  const workDir = mkdtempSync(join(tmpdir(), 'kimi-acp-work-'));
  const agent = spawnAgent(mainPath, { homeDir, env: { KIMI_ACP_DEBUG: '1' } });
  try {
    await body({ agent, provider, workDir });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    await agent.close();
    await provider.close();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function newSession(agent, workDir) {
  await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.request('session/new', { cwd: workDir, mcpServers: [] });
  if (typeof created.sessionId !== 'string') throw new Error('session/new returned no sessionId');
  ok(`session ${created.sessionId}`);
  return created.sessionId;
}

/** A plain turn: the reply streams, coalesced, and the run ends at the turn. */
async function turnScenario() {
  await withAgent({ text: REPLY }, async ({ agent, provider, workDir }) => {
    const sessionId = await newSession(agent, workDir);

    const startedAt = Date.now();
    const response = await agent.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'say hello' }] },
      120_000,
    );
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason was ${response.stopReason}`);
    ok(`prompt settled end_turn in ${Date.now() - startedAt} ms`);

    const chunks = agent
      .sessionUpdates()
      .filter((update) => update.sessionUpdate === 'agent_message_chunk');
    const text = chunks.map((update) => update.content?.text ?? '').join('');
    if (text !== REPLY) throw new Error(`streamed text was ${JSON.stringify(text)}`);
    const ids = new Set(chunks.map((update) => update.messageId));
    if (ids.size !== 1) throw new Error(`expected one messageId, saw ${[...ids].join(', ')}`);
    ok(`${chunks.length} chunk(s), one messageId, text matches`);

    if (provider.requests.length !== 1) {
      throw new Error(`expected one model request, saw ${provider.requests.length}`);
    }
    if (!provider.requests[0].body.includes('say hello')) {
      throw new Error('the model request did not carry the prompt');
    }
    ok('one model request carried the prompt');
  });
}

/** Cancelling mid-turn settles the run as `cancelled` instead of hanging. */
async function cancelScenario() {
  await withAgent(
    { text: 'This reply is cancelled before it ends.', delayMs: 30_000 },
    async ({ agent, workDir }) => {
      const sessionId = await newSession(agent, workDir);
      const pending = agent.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: 'write an essay' }] },
        60_000,
      );
      // Let the turn start, then cancel it while the provider still stalls.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      agent.notify('session/cancel', { sessionId });
      const response = await pending;
      if (response.stopReason !== 'cancelled') {
        throw new Error(`cancel scenario returned ${response.stopReason}`);
      }
      ok('session/cancel settled the run as cancelled');
    },
  );
}

await turnScenario();
await cancelScenario();
ok('M0 end-to-end: turn, coalesced stream, end_turn, cancel');