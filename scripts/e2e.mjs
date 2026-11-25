#!/usr/bin/env node
/**
 * M1 end-to-end: real engine turns over ACP, driven by a fake provider.
 *
 *   node scripts/e2e.mjs
 *
 * What it proves:
 *   - `session/prompt` reaches the engine as a run and settles once (quiescence)
 *   - assistant deltas arrive coalesced, sharing one `messageId`
 *   - `session/cancel` settles the run as `cancelled`
 *   - a tool call is projected as a card, and a command's output is mirrored to
 *     the client as `_meta.terminal_output` with `terminal_info`/`terminal_exit`
 *     — the agent owns execution, the client renders a shadow
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

function fail(message) {
  process.stderr.write(`[e2e] FAIL ${message}\n`);
  process.exit(1);
}

function ok(message) {
  process.stderr.write(`[e2e] ok ${message}\n`);
}

/** Boot an agent with a fake provider and throwaway home/work directories. */
async function withAgent(options, body) {
  const provider = await startFakeProvider(options);
  const homeDir = writeFakeHome({ baseUrl: provider.baseUrl });
  const workDir = mkdtempSync(join(tmpdir(), 'kimi-acp-work-'));
  const agent = spawnAgent(mainPath, { homeDir, env: { KIMI_ACP_DEBUG: '1' } });
  let failed = false;
  try {
    await body({ agent, provider, workDir });
  } catch (error) {
    failed = true;
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    await agent.close();
    await provider.close();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
  // `fail` exits; this keeps types honest for the happy path.
  if (failed) process.exit(1);
}

async function newSession(agent, workDir, capabilities = {}) {
  await agent.request('initialize', { protocolVersion: 1, clientCapabilities: capabilities });
  agent.onRequest('session/request_permission', () => ({
    outcome: { outcome: 'selected', optionId: 'approve_once' },
  }));
  const created = await agent.request('session/new', { cwd: workDir, mcpServers: [] });
  if (typeof created.sessionId !== 'string') throw new Error('session/new returned no sessionId');
  ok(`session ${created.sessionId}`);
  return created.sessionId;
}

function updates(agent) {
  return agent.sessionUpdates();
}

/** A plain turn: the reply streams, coalesced, and the run ends at the turn. */
async function turnScenario() {
  const reply = 'Hello from the fake provider.';
  await withAgent({ script: [{ kind: 'text', text: reply }] }, async ({ agent, provider, workDir }) => {
    const sessionId = await newSession(agent, workDir);

    const startedAt = Date.now();
    const response = await agent.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'say hello' }] },
      120_000,
    );
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason was ${response.stopReason}`);
    ok(`prompt settled end_turn in ${Date.now() - startedAt} ms`);

    const chunks = updates(agent).filter((update) => update.sessionUpdate === 'agent_message_chunk');
    const text = chunks.map((update) => update.content?.text ?? '').join('');
    if (text !== reply) throw new Error(`streamed text was ${JSON.stringify(text)}`);
    const ids = new Set(chunks.map((update) => update.messageId));
    if (ids.size !== 1) throw new Error(`expected one messageId, saw ${[...ids].join(', ')}`);
    ok(`${chunks.length} chunk(s), one messageId, text matches`);

    if (provider.requests.length !== 1) throw new Error(`expected one model request, saw ${provider.requests.length}`);
    if (!provider.requests[0].body.includes('say hello')) throw new Error('the model request did not carry the prompt');
    ok('one model request carried the prompt');
  });
}

/** Cancelling mid-turn settles the run as `cancelled` instead of hanging. */
async function cancelScenario() {
  await withAgent(
    { script: [{ kind: 'text', text: 'This reply is cancelled before it ends.' }], delayMs: 30_000 },
    async ({ agent, workDir }) => {
      const sessionId = await newSession(agent, workDir);
      const pending = agent.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: 'write an essay' }] },
        60_000,
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      agent.notify('session/cancel', { sessionId });
      const response = await pending;
      if (response.stopReason !== 'cancelled') throw new Error(`cancel scenario returned ${response.stopReason}`);
      ok('session/cancel settled the run as cancelled');
    },
  );
}

/**
 * The flagship behaviour: the engine runs the command, the client gets a card
 * and a display terminal — `terminal_info` to create it, `terminal_output`
 * chunks to feed it, `terminal_exit` to close it. No `terminal/*` reverse RPC.
 */
async function terminalScenario() {
  const command = 'echo terminal-hello';
  const script = [
    { kind: 'tool', id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command }) },
    { kind: 'text', text: 'finished' },
  ];
  await withAgent({ script }, async ({ agent, workDir }) => {
    const sessionId = await newSession(agent, workDir, { _meta: { terminal_output: true } });

    const response = await agent.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'run the command' }] },
      180_000,
    );
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason was ${response.stopReason}`);

    const toolUpdates = updates(agent).filter(
      (update) => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update',
    );
    const created = toolUpdates.find((update) => update.sessionUpdate === 'tool_call');
    if (created === undefined) throw new Error('no tool_call card was projected');
    const terminalId = created._meta?.terminal_info?.terminal_id;
    if (typeof terminalId !== 'string') throw new Error('tool_call carried no _meta.terminal_info');
    if (!created.content?.some((entry) => entry.type === 'terminal')) {
      throw new Error('tool_call content did not reference the terminal');
    }
    ok(`tool card + terminal_info (${terminalId})`);

    const output = toolUpdates
      .map((update) => update._meta?.terminal_output)
      .filter((chunk) => chunk !== undefined)
      .map((chunk) => chunk.data)
      .join('');
    if (!output.includes('terminal-hello')) throw new Error(`terminal output did not carry the command's output: ${JSON.stringify(output)}`);
    ok('terminal_output carried the command output');

    const exit = toolUpdates.map((update) => update._meta?.terminal_exit).find((entry) => entry !== undefined);
    if (exit === undefined) throw new Error('no _meta.terminal_exit');
    if (exit.exit_code !== 0) throw new Error(`terminal_exit carried ${JSON.stringify(exit)}`);
    ok('terminal_exit carried exit code 0');

    const completed = toolUpdates.filter((update) => update.status === 'completed');
    if (completed.length === 0) throw new Error('the tool call never completed');
    const finalText = updates(agent)
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content?.text ?? '')
      .join('');
    if (finalText !== 'finished') throw new Error(`second turn text was ${JSON.stringify(finalText)}`);
    const permissions = agent.requestsOf('session/request_permission');
    ok(`tool completed, follow-up turn finished (${permissions.length} permission request(s))`);
  });
}

await turnScenario();
await cancelScenario();
await terminalScenario();
ok('M1 end-to-end: turn, stream, cancel, tool card, shadow terminal');
