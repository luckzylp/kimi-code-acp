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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
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
  const agent = spawnAgent(mainPath, {
    homeDir,
    env: { KIMI_ACP_DEBUG: '1', ...(options.env ?? {}) },
  });
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

/** The last agent text in the transcript, for asserting a command's answer. */
function lastAgentText(agent) {
  return updates(agent)
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => update.content?.text ?? '')
    .join('\n');
}

/** Poll until `predicate` holds or the timeout expires. */
async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * The session surface a client renders: config options (model, thinking, mode),
 * modes, slash commands and the context indicator.
 */
async function surfaceScenario() {
  await withAgent({ script: [{ kind: 'text', text: 'ok' }] }, async ({ agent, workDir }) => {
    const init = await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const created = await agent.request('session/new', { cwd: workDir, mcpServers: [] });
    if (typeof created.sessionId !== 'string') throw new Error('session/new returned no sessionId');
    const ids = (created.configOptions ?? []).map((option) => option.id);
    for (const expected of ['model', 'thinking', 'mode']) {
      if (!ids.includes(expected)) throw new Error(`session/new config options lack "${expected}": ${ids.join(', ')}`);
    }
    if (created.modes === undefined || typeof created.modes.currentModeId !== 'string') {
      throw new Error('session/new returned no mode state');
    }
    const authMethods = init.authMethods ?? [];
    const login = authMethods.find((method) => method.id === 'login');
    if (login === undefined || login.type !== 'terminal' || !(login.args ?? []).includes('login')) {
      throw new Error('initialize did not advertise the terminal login method');
    }
    ok('initialize advertises the terminal login method');
    ok(`config options ${ids.join(', ')}; mode ${created.modes.currentModeId}`);

    await waitFor(
      () => updates(agent).some((update) => update.sessionUpdate === 'available_commands_update'),
      5_000,
      'available_commands_update',
    );
    await waitFor(
      () => updates(agent).some((update) => update.sessionUpdate === 'usage_update'),
      5_000,
      'usage_update',
    );
    ok('commands and usage arrived after the response');

    await agent.request('session/set_mode', { sessionId: created.sessionId, modeId: 'plan' });
    const modeUpdates = updates(agent).filter((update) => update.sessionUpdate === 'current_mode_update');
    if (modeUpdates.at(-1)?.currentModeId !== 'plan') throw new Error('set_mode did not switch to plan');
    await agent.request('session/set_mode', { sessionId: created.sessionId, modeId: 'default' });
    ok('session/set_mode switched plan mode on and off');

    const modelOption = created.configOptions.find((option) => option.id === 'model');
    const model = modelOption.currentValue;
    const configured = await agent.request('session/set_config_option', {
      sessionId: created.sessionId,
      configId: 'model',
      value: model,
    });
    const applied = (configured.configOptions ?? []).find((option) => option.id === 'model');
    if (applied?.currentValue !== model) throw new Error('set_config_option did not keep the model');
    if (!updates(agent).some((update) => update.sessionUpdate === 'config_option_update')) {
      throw new Error('set_config_option posted no config_option_update');
    }
    ok(`session/set_config_option applied model ${String(model)}`);

    const providers = await agent.request('providers/list', {});
    if (!Array.isArray(providers.providers)) throw new Error('providers/list returned no providers array');
    ok(`providers/list (v1) returned ${String(providers.providers.length)} provider(s)`);

    const usageBefore = updates(agent).filter((update) => update.sessionUpdate === 'usage_update').length;
    await agent.request('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'hi' }] }, 60_000);
    await waitFor(
      () => updates(agent).filter((update) => update.sessionUpdate === 'usage_update').length > usageBefore,
      5_000,
      'usage_update after the turn',
    );
    ok('usage_update refreshed after the turn');

    let rejected = false;
    try {
      await agent.request('authenticate', { methodId: 'nope' });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error('authenticate accepted an unknown method');
    ok('authenticate rejects an unknown method');
  });
}

/**
 * Cancelling while a permission dialog is open: the client answers the
 * outstanding request with \`cancelled\` (as ACP requires) and the run ends
 * cancelled instead of waiting for a decision nobody will make.
 */
async function cancelDuringPermissionScenario() {
  await withAgent(
    { script: [{ kind: 'tool', id: 'call_gate', name: 'Bash', arguments: JSON.stringify({ command: 'rm -rf /tmp/kimi-acp-gated' }) }] },
    async ({ agent, workDir }) => {
      await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
      const pending = [];
      agent.onRequest('session/request_permission', () => new Promise((resolvePromise) => {
        pending.push(resolvePromise);
      }));
      const created = await agent.request('session/new', { cwd: workDir, mcpServers: [] });
      const promptPromise = agent.request(
        'session/prompt',
        { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'run it' }] },
        60_000,
      );
      await waitFor(() => pending.length > 0, 10_000, 'the permission request');
      agent.notify('session/cancel', { sessionId: created.sessionId });
      pending[0]({ outcome: { outcome: 'cancelled' } });
      const response = await promptPromise;
      if (response.stopReason !== 'cancelled') {
        throw new Error(`cancelling a pending permission returned ${response.stopReason}`);
      }
      ok('session/cancel with an open permission dialog settled as cancelled');
    },
  );
}

/**
 * `$/cancel_request` cancels the request it names — the protocol-level cancel
 * clients use when they drop a request without a `session/cancel`.
 */
async function cancelRequestScenario() {
  await withAgent(
    { script: [{ kind: 'text', text: 'never finishes' }], delayMs: 30_000 },
    async ({ agent, workDir }) => {
      const sessionId = await newSession(agent, workDir);
      const { id, promise } = agent.beginRequest(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: 'take your time' }] },
        60_000,
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      agent.notify('$/cancel_request', { requestId: id });
      const response = await promise;
      if (response.stopReason !== 'cancelled') {
        throw new Error(`$/cancel_request returned ${response.stopReason}`);
      }
      ok('$/cancel_request cancelled the prompt it named');
    },
  );
}

/**
 * ACP v2: the router negotiates the draft protocol, the same run model serves
 * the turn, and updates come in the v2 vocabulary (state_update, message
 * chunks with messageId, plan_update) with `session/prompt` answering no stop
 * reason.
 */
async function v2Scenario() {
  const script = [
    { kind: 'text', text: 'v2 hello' },
    { kind: 'tool', id: 'call_v2', name: 'Bash', arguments: JSON.stringify({ command: 'rm -rf /tmp/kimi-acp-v2-perm && echo v2-tool' }) },
    { kind: 'text', text: 'v2 done' },
  ];
  await withAgent({ script }, async ({ agent, workDir }) => {
    const init = await agent.request('initialize', {
      protocolVersion: 2,
      info: { name: 'zed-v2-test', version: '0.0.0' },
    });
    if (init.protocolVersion !== 2) throw new Error(`v2 initialize answered ${String(init.protocolVersion)}`);
    if (init.info?.name === undefined) throw new Error('v2 initialize returned no agent info');
    if (!Array.isArray(init.authMethods) || init.authMethods.length === 0) {
      throw new Error('v2 initialize advertised no auth methods');
    }
    agent.onRequest('session/request_permission', () => ({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    }));
    ok(`v2 initialize → protocolVersion 2 (${init.info.name})`);

    const created = await agent.request('session/new', { cwd: workDir });
    if (typeof created.sessionId !== 'string') throw new Error('v2 session/new returned no sessionId');
    ok('v2 session/new created a session');

    const response = await agent.request(
      'session/prompt',
      { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'hello v2' }] },
      180_000,
    );
    if (response.stopReason !== undefined) {
      throw new Error('v2 session/prompt carried a v1 stop reason');
    }

    const updatesV2 = updates(agent);
    const text = updatesV2
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content?.text ?? '')
      .join('');
    if (text !== 'v2 hello') throw new Error(`v2 text was ${JSON.stringify(text)}`);
    const chunk = updatesV2.find((update) => update.sessionUpdate === 'agent_message_chunk');
    if (typeof chunk.messageId !== 'string') throw new Error('v2 chunk carried no messageId');
    const states = updatesV2
      .filter((update) => update.sessionUpdate === 'state_update')
      .map((update) => update.state);
    if (!states.includes('running') || !states.includes('idle')) {
      throw new Error(`v2 state updates were ${JSON.stringify(states)}`);
    }
    ok('v2 turn streamed a message chunk and running → idle states');

    // A tool turn: v2 has one `tool_call_update` and native terminal updates.
    // Pin manual approval so the permission path is exercised on any engine
    // default (2.8 auto-approves safe commands under its own policy).
    await agent.request('session/set_config_option', {
      sessionId: created.sessionId,
      configId: 'mode',
      type: 'id',
      value: 'default',
    });
    await agent.request(
      'session/prompt',
      { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'run the command' }] },
      180_000,
    );
    const toolUpdates = updates(agent).filter(
      (update) => update.sessionUpdate === 'tool_call_update' && typeof update.toolCallId === 'string',
    );
    if (toolUpdates.length === 0) throw new Error('v2 turn projected no tool_call_update');
    if (agent.requestsOf('session/request_permission').length === 0) {
      throw new Error('v2 tool turn asked for no permission');
    }
    const terminalChunks = updates(agent).filter(
      (update) => update.sessionUpdate === 'terminal_output_chunk',
    );
    if (terminalChunks.length === 0) {
      throw new Error(`v2 terminal produced no output chunk; kinds=${updates(agent).map((u) => u.sessionUpdate).join(',')}`);
    }
    const terminalOutput = terminalChunks.map((update) => update.data ?? '').join('');
    if (!terminalOutput.includes('v2-tool')) throw new Error('v2 terminal chunk lacked the output');
    ok('v2 tool turn: tool_call_update, permission request, terminal_output_chunk');

    const providers = await agent.request('providers/list', {});
    if (!Array.isArray(providers.providers)) throw new Error('providers/list returned no providers array');
    ok(`providers/list returned ${String(providers.providers.length)} provider(s)`);
  });
}

/** A client that appends chunks gets `terminal_output_delta` instead. */
async function terminalDeltaScenario() {
  const command = 'echo delta-hello';
  const script = [
    { kind: 'tool', id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command }) },
    { kind: 'text', text: 'finished' },
  ];
  await withAgent({ script }, async ({ agent, workDir }) => {
    const sessionId = await newSession(agent, workDir, { _meta: { terminal_output_delta: true } });
    await agent.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'run the command' }] },
      180_000,
    );
    const toolUpdates = updates(agent).filter(
      (update) => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update',
    );
    const deltas = toolUpdates
      .map((update) => update._meta?.terminal_output_delta)
      .filter((chunk) => chunk !== undefined);
    if (deltas.length === 0) throw new Error('no _meta.terminal_output_delta was sent');
    const output = deltas.map((chunk) => chunk.data).join('');
    if (!output.includes('delta-hello')) throw new Error('delta chunks lacked the command output');
    if (toolUpdates.some((update) => update._meta?.terminal_output !== undefined)) {
      throw new Error('terminal_output was sent to a delta-capable client');
    }
    ok('terminal_output_delta carried the command output');
  });
}

/** A client-declared MCP server becomes a session-local engine server. */
async function mcpScenario() {
  const script = [
    {
      kind: 'tool',
      id: 'call_mcp',
      name: 'mcp__echo__echo',
      arguments: JSON.stringify({ text: 'mcp-hello' }),
    },
    { kind: 'text', text: 'mcp done' },
  ];
  await withAgent({ script }, async ({ agent, workDir }) => {
    const server = {
      name: 'echo',
      command: process.execPath,
      args: [join(repoRoot, 'scripts', 'lib', 'mcp-echo-server.mjs')],
      env: [],
    };
    await agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    agent.onRequest('session/request_permission', () => ({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    }));
    const created = await agent.request('session/new', { cwd: workDir, mcpServers: [server] });
    ok('session/new accepted a client MCP server');

    // The engine connects asynchronously; wait until the server reports connected.
    const deadline = Date.now() + 20_000;
    let listed = '';
    while (Date.now() < deadline) {
      await agent.request(
        'session/prompt',
        { sessionId: created.sessionId, prompt: [{ type: 'text', text: '/mcp' }] },
        30_000,
      );
      listed = updates(agent)
        .filter((update) => update.sessionUpdate === 'agent_message_chunk')
        .map((update) => update.content?.text ?? '')
        .join('\n');
      if (/echo\s+\[connected\]/.test(listed)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    if (!/echo\s+\[connected\]/.test(listed)) {
      throw new Error(`the MCP server never connected: ${listed.slice(-300)}`);
    }
    ok('/mcp lists the client-declared server as connected');

    await agent.request(
      'session/prompt',
      { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'use the echo tool' }] },
      180_000,
    );
    const toolCards = updates(agent).filter(
      (update) =>
        update.sessionUpdate === 'tool_call_update' && update.toolCallId?.includes('call_mcp'),
    );
    if (toolCards.length === 0) throw new Error('the MCP tool call was not projected');
    const resultText = updates(agent)
      .filter((update) => update.sessionUpdate === 'tool_call_update')
      .map((update) => JSON.stringify(update.content ?? ''))
      .join('\n');
    if (!resultText.includes('mcp-hello')) throw new Error('the MCP tool result did not come back');
    ok('the model called the MCP tool and its result came back');
  });
}

/**
 * MCP-over-ACP (v2): the client hosts the MCP server, the agent tunnels to it
 * through mcp/connect + mcp/message, and the engine reaches it through the
 * bridge proxy. The tool must behave exactly like a declared server.
 */
async function mcpAcpScenario() {
  const script = [
    {
      kind: 'tool',
      id: 'call_acp_mcp',
      name: 'mcp__acp-echo__echo',
      arguments: JSON.stringify({ text: 'acp-hello' }),
    },
    { kind: 'text', text: 'acp mcp done' },
  ];
  await withAgent({ script }, async ({ agent, workDir }) => {
    const calls = [];
    await agent.request('initialize', {
      protocolVersion: 2,
      info: { name: 'v2-mcp-client', version: '0.0.0' },
    });
    agent.onRequest('session/request_permission', () => ({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    }));
    agent.onRequest('mcp/connect', (params) => {
      calls.push(['connect', 'connect', params.serverId]);
      return { connectionId: `conn-${params.serverId}` };
    });
    agent.onRequest('mcp/message', (params) => {
      calls.push(['message', params.method]);
      switch (params.method) {
        case 'initialize':
          return {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'acp-echo', version: '1.0.0' },
          };
        case 'tools/list':
          return {
            tools: [
              {
                name: 'echo',
                description: 'Echo the given text back',
                inputSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text'],
                },
              },
            ],
          };
        case 'tools/call':
          return {
            content: [{ type: 'text', text: String(params.params?.arguments?.text ?? '') }],
            isError: false,
          };
        default:
          return {};
      }
    });

    const created = await agent.request('session/new', {
      cwd: workDir,
      mcpServers: [{ type: 'acp', name: 'acp-echo', serverId: 'srv-acp' }],
    });
    ok('v2 session/new connected the client-hosted MCP server');

    await agent.request(
      'session/prompt',
      { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'use the acp echo tool' }] },
      180_000,
    );
    const methods = calls.filter(([, method]) => method !== undefined).map(([, method]) => method);
    if (!methods.includes('connect')) throw new Error('mcp/connect was never called');
    if (!methods.includes('initialize') || !methods.includes('tools/list') || !methods.includes('tools/call')) {
      throw new Error(`MCP-over-ACP methods seen: ${methods.join(',')}`);
    }
    const resultText = updates(agent)
      .filter((update) => update.sessionUpdate === 'tool_call_update')
      .map((update) => JSON.stringify(update.content ?? ''))
      .join('\n');
    if (!resultText.includes('acp-hello')) throw new Error('the MCP-over-ACP tool result did not come back');
    ok('the model called the client-hosted MCP tool and its result came back');
  });
}

/**
 * Prompt suggestions: with the engine's prediction experiment on and the client
 * advertising `session.promptSuggestions`, a turn publishes the predicted next
 * prompt as ACP's `prompt_suggestions_update`.
 */
async function suggestionScenario() {
  await withAgent(
    {
      script: [
        { kind: 'text', text: 'the answer' },
        { kind: 'text', text: JSON.stringify({ show: 'yes', message: 'run the tests' }) },
      ],
      env: { KIMI_CODE_EXPERIMENTAL_PROMPT_PREDICTION: '1' },
    },
    async ({ agent, workDir }) => {
      await agent.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { session: { promptSuggestions: {} } },
      });
      agent.onRequest('session/request_permission', () => ({
        outcome: { outcome: 'selected', optionId: 'approve_once' },
      }));
      const created = await agent.request('session/new', { cwd: workDir, mcpServers: [] });
      await agent.request(
        'session/prompt',
        { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'hello' }] },
        60_000,
      );
      await waitFor(
        () =>
          updates(agent).some(
            (update) =>
              update.sessionUpdate === 'prompt_suggestions_update' &&
              (update.suggestions ?? []).length > 0,
          ),
        20_000,
        'the prompt suggestion',
      );
      const suggestion = updates(agent)
        .filter((update) => update.sessionUpdate === 'prompt_suggestions_update')
        .at(-1);
      const text = suggestion.suggestions?.[0]?.prompt?.[0]?.text;
      if (text !== 'run the tests') throw new Error(`unexpected suggestion: ${JSON.stringify(text)}`);
      ok('prompt_suggestions_update carried the predicted prompt');
    },
  );
}

/** AIR's `_session/goal`: set and clear the goal, reflected in the goal card. */
async function goalExtensionScenario() {
  // A goal can start a continuation turn; give the fake provider an answer.
  await withAgent(
    { script: [{ kind: 'text', text: 'goal continued' }, { kind: 'text', text: 'goal continued again' }] },
    async ({ agent, workDir }) => {
      const sessionId = await newSession(agent, workDir);
      const set = await agent.request('_session/goal', {
        sessionId,
        action: 'set',
        objective: 'ship the adapter',
      });
      if (typeof set !== 'object') throw new Error('_session/goal set returned no response');
      await waitFor(
        () =>
          updates(agent).some(
            (update) => update.sessionUpdate === 'tool_call' && String(update.toolCallId).startsWith('goal:'),
          ),
        10_000,
        'the goal card',
      );
      ok('_session/goal set opened the goal card');

      await agent.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: '/goal status' }] },
        30_000,
      );
      const listed = lastAgentText(agent);
      if (!listed.includes('ship the adapter') || !listed.includes('Status: active')) {
        throw new Error(`/goal status did not report the goal: ${listed.slice(-300)}`);
      }
      ok('/goal status reports the goal set through the extension');

      await agent.request('_session/goal', { sessionId, action: 'clear' });
      await waitFor(
        () =>
          updates(agent).some(
            (update) =>
              update.sessionUpdate === 'tool_call_update' &&
              String(update.toolCallId).startsWith('goal:') &&
              update.status === 'completed' &&
              JSON.stringify(update.content ?? '').includes('Goal cancelled'),
          ),
        10_000,
        'the cleared goal card',
      );
      ok('_session/goal clear closed the goal card');
    },
  );
}

/** Built-in slash commands answer locally, without a model request. */
async function commandScenario() {
  await withAgent({ script: [] }, async ({ agent, provider, workDir }) => {
    const sessionId = await newSession(agent, workDir);
    await waitFor(
      () => updates(agent).some((update) => update.sessionUpdate === 'available_commands_update'),
      5_000,
      'available_commands_update',
    );
    const advertisement = updates(agent).find(
      (update) => update.sessionUpdate === 'available_commands_update',
    );
    const names = (advertisement.availableCommands ?? []).map((command) => command.name);
    for (const expected of ['goal', 'swarm', 'compact', 'status', 'permission', 'model', 'effort']) {
      if (!names.includes(expected)) throw new Error(`command "${expected}" is not advertised`);
    }
    ok(`${String(names.length)} commands advertised (built-ins + skills/plugins)`);

    const status = await agent.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: '/status' }] },
      30_000,
    );
    if (status.stopReason !== 'end_turn') throw new Error('/status did not settle as end_turn');
    const statusText = lastAgentText(agent);
    if (!statusText.includes('Model:') || !statusText.includes('Permission:')) {
      throw new Error(`/status answered nothing useful: ${statusText}`);
    }
    ok('/status answered with the session status');

    await agent.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: '/swarm off' }] },
      30_000,
    );
    if (!lastAgentText(agent).includes('Swarm mode off')) throw new Error('/swarm off did not answer');
    if (provider.requests.length !== 0) throw new Error('a local command reached the model');
    ok('/swarm off answered locally, with no model request');
  });
}

/** Steering: injected into the running turn, and `promptRequired` when idle. */
async function steeringScenario() {
  await withAgent(
    {
      script: [{ kind: 'text', text: 'slow answer' }, { kind: 'text', text: 'second answer' }],
      delayMs: 3_000,
    },
    async ({ agent, workDir }) => {
      const sessionId = await newSession(agent, workDir);
      const first = agent.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: 'start the slow turn' }] },
        60_000,
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      const steered = await agent.request(
        '_session/steering',
        { sessionId, prompt: [{ type: 'text', text: 'also check the tests' }] },
        30_000,
      );
      if (steered.outcome !== 'injected') {
        throw new Error(`steering returned ${String(steered.outcome)}, expected injected`);
      }
      ok('_session/steering injected into the running turn');
      const response = await first;
      if (response.stopReason !== 'end_turn') throw new Error('the steered run did not finish');

      const idle = await agent.request(
        '_session/steering',
        {
          sessionId,
          prompt: [{ type: 'text', text: 'later' }],
          _meta: { steering: { idleBehavior: 'promptRequired' } },
        },
        30_000,
      );
      if (idle.outcome !== 'promptRequired') {
        throw new Error(`idle steering returned ${String(idle.outcome)}, expected promptRequired`);
      }
      ok('idle steering honoured promptRequired');
    },
  );
}

/** A TodoList call becomes the session's ACP plan (Zed's todo list). */
async function planScenario() {
  const script = [
    {
      kind: 'tool',
      id: 'call_todo',
      name: 'TodoList',
      arguments: JSON.stringify({
        todos: [
          { title: 'write the tests', status: 'done' },
          { title: 'ship it', status: 'in_progress' },
          { title: 'tell the user', status: 'pending' },
        ],
      }),
    },
    { kind: 'text', text: 'noted' },
  ];
  await withAgent({ script }, async ({ agent, workDir }) => {
    const sessionId = await newSession(agent, workDir);
    const response = await agent.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'plan the work' }] },
      120_000,
    );
    if (response.stopReason !== 'end_turn') throw new Error('the plan turn did not finish');
    const plan = updates(agent).find((update) => update.sessionUpdate === 'plan');
    if (plan === undefined) throw new Error('TodoList produced no plan update');
    const entries = plan.entries ?? [];
    const byContent = new Map(entries.map((entry) => [entry.content, entry.status]));
    if (byContent.get('write the tests') !== 'completed') throw new Error('done step was not completed');
    if (byContent.get('ship it') !== 'in_progress') throw new Error('active step was not in_progress');
    if (byContent.get('tell the user') !== 'pending') throw new Error('pending step was not pending');
    ok(`TodoList projected as a plan (${String(entries.length)} entries)`);
  });
}

/**
 * Prompt content beyond text: an image is attached to the engine's media store
 * and a linked markdown file is read on the host and inlined.
 */
async function promptContentScenario() {
  // 1x1 transparent PNG.
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await withAgent({ script: [{ kind: 'text', text: 'described' }] }, async ({ agent, provider, workDir }) => {
    const notesPath = join(workDir, 'IMAGE-NOTES.md');
    writeFileSync(notesPath, 'IMAGE-NOTES: a one pixel image', 'utf8');
    await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const created = await agent.request('session/new', { cwd: workDir, mcpServers: [] });
    const response = await agent.request(
      'session/prompt',
      {
        sessionId: created.sessionId,
        prompt: [
          { type: 'text', text: 'describe the image' },
          { type: 'image', data: png, mimeType: 'image/png' },
          {
            type: 'resource_link',
            uri: pathToFileURL(notesPath).href,
            name: 'image-notes.md',
            mimeType: 'text/markdown',
          },
        ],
      },
      120_000,
    );
    if (response.stopReason !== 'end_turn') throw new Error('the content prompt did not finish');
    const body = provider.requests[0]?.body ?? '';
    if (!body.includes('IMAGE-NOTES')) throw new Error('the linked resource was not inlined into the prompt');
    if (!/image_url|data:image\/png/.test(body)) throw new Error('the image was not attached to the prompt');
    ok('prompt carried an attached image and an inlined linked file');
  });
}

/**
 * `session/fork` and `session/delete`: a fork is a new engine session that
 * accepts prompts, and deleting it removes it from the listing.
 */
async function lifecycleScenario() {
  await withAgent(
    { script: [{ kind: 'text', text: 'one' }, { kind: 'text', text: 'two' }] },
    async ({ agent, workDir }) => {
      const sessionId = await newSession(agent, workDir);
      await agent.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: 'first' }] },
        60_000,
      );
      const forked = await agent.request('session/fork', { sessionId, cwd: workDir, mcpServers: [] });
      if (typeof forked.sessionId !== 'string' || forked.sessionId === sessionId) {
        throw new Error('session/fork did not return a new session');
      }
      ok(`session/fork → ${forked.sessionId}`);

      const response = await agent.request(
        'session/prompt',
        { sessionId: forked.sessionId, prompt: [{ type: 'text', text: 'second' }] },
        60_000,
      );
      if (response.stopReason !== 'end_turn') throw new Error('the forked session did not accept a prompt');
      ok('the forked session accepted a prompt');

      const before = await agent.request('session/list', {});
      if (!before.sessions.some((entry) => entry.sessionId === forked.sessionId)) {
        throw new Error('session/list does not include the fork');
      }
      await agent.request('session/delete', { sessionId: forked.sessionId });
      const after = await agent.request('session/list', {});
      if (after.sessions.some((entry) => entry.sessionId === forked.sessionId)) {
        throw new Error('session/delete left the fork in the listing');
      }
      ok('session/delete removed the fork from the listing');
    },
  );
}

/** `session/load` restores the plan from the TodoList call in history. */
async function replayPlanScenario() {
  const script = [
    {
      kind: 'tool',
      id: 'call_todo',
      name: 'TodoList',
      arguments: JSON.stringify({ todos: [{ title: 'restore me', status: 'in_progress' }] }),
    },
    { kind: 'text', text: 'planned' },
  ];
  const provider = await startFakeProvider({ script });
  const homeDir = writeFakeHome({ baseUrl: provider.baseUrl });
  const workDir = mkdtempSync(join(tmpdir(), 'kimi-acp-work-'));
  let sessionId;
  const first = spawnAgent(mainPath, { homeDir });
  try {
    await first.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    first.onRequest('session/request_permission', () => ({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    }));
    const created = await first.request('session/new', { cwd: workDir, mcpServers: [] });
    sessionId = created.sessionId;
    await first.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'plan it' }] },
      60_000,
    );
  } finally {
    await first.close();
  }
  const second = spawnAgent(mainPath, { homeDir });
  try {
    await second.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await second.request('session/load', { sessionId, cwd: workDir, mcpServers: [] }, 60_000);
    const plan = second.sessionUpdates().find((update) => update.sessionUpdate === 'plan');
    if (plan === undefined) throw new Error('session/load did not restore the plan');
    const entry = (plan.entries ?? []).find((item) => item.content === 'restore me');
    if (entry?.status !== 'in_progress') throw new Error('the restored plan lost its status');
    ok('session/load restored the plan from history');
  } finally {
    await second.close();
    await provider.close();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Persistence and `session/load`: a second process reopens the session, the
 * adapter replays its history as updates (stripping injected reminders), and
 * the resumed session accepts a new prompt.
 */
async function loadScenario() {
  const command = 'echo replay-hello';
  const provider = await startFakeProvider({
    script: [
      { kind: 'tool', id: 'call_replay', name: 'Bash', arguments: JSON.stringify({ command }) },
      { kind: 'text', text: 'first reply' },
      { kind: 'text', text: 'resumed reply' },
    ],
  });
  const homeDir = writeFakeHome({ baseUrl: provider.baseUrl });
  const workDir = mkdtempSync(join(tmpdir(), 'kimi-acp-work-'));
  let sessionId;
  const first = spawnAgent(mainPath, { homeDir });
  try {
    await first.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    first.onRequest('session/request_permission', () => ({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    }));
    const created = await first.request('session/new', { cwd: workDir, mcpServers: [] });
    sessionId = created.sessionId;
    const response = await first.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'run the replay command' }] },
      120_000,
    );
    if (response.stopReason !== 'end_turn') throw new Error('first process did not finish its turn');
  } finally {
    await first.close();
  }

  const second = spawnAgent(mainPath, { homeDir });
  try {
    const init = await second.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    if (init.agentCapabilities?.loadSession !== true) throw new Error('loadSession is not advertised');

    const listed = await second.request('session/list', {});
    if (!listed.sessions.some((entry) => entry.sessionId === sessionId)) {
      throw new Error('session/list does not include the created session');
    }
    ok(`session/list → ${listed.sessions.length} session(s), including ${sessionId}`);

    await second.request('session/load', {
      sessionId,
      cwd: workDir,
      mcpServers: [
        {
          name: 'echo',
          command: process.execPath,
          args: [join(repoRoot, 'scripts', 'lib', 'mcp-echo-server.mjs')],
          env: [],
        },
      ],
    }, 120_000);
    const replayed = second.sessionUpdates();
    const text = replayed
      .filter((update) => update.sessionUpdate === 'user_message_chunk' || update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content?.text ?? '')
      .join('\n');
    if (!text.includes('run the replay command')) throw new Error('replay lost the user prompt');
    if (!text.includes('first reply')) throw new Error('replay lost the assistant reply');
    if (text.includes('<system-reminder>') || text.includes('<task-notification>')) {
      throw new Error('replay leaked injected context');
    }
    const cards = replayed.filter((update) => update.sessionUpdate === 'tool_call');
    if (cards.length === 0) throw new Error('replay lost the tool card');
    const completed = replayed.filter(
      (update) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed',
    );
    if (completed.length === 0) throw new Error('replay lost the tool result');
    ok(`session/load replayed ${replayed.length} update(s): prompt, reply, tool card and result`);

    // The load's client MCP server must be connected and listed for the resumed session.
    const deadline = Date.now() + 20_000;
    let mcpList = '';
    while (Date.now() < deadline) {
      await second.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: '/mcp' }] },
        30_000,
      );
      mcpList = second
        .sessionUpdates()
        .filter((update) => update.sessionUpdate === 'agent_message_chunk')
        .map((update) => update.content?.text ?? '')
        .join('\n');
      if (/echo\s+\[connected\]/.test(mcpList)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    if (!/echo\s+\[connected\]/.test(mcpList)) {
      throw new Error(`session/load did not connect its MCP server: ${mcpList.slice(-300)}`);
    }
    ok('session/load connected the client-declared MCP server');

    const response = await second.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'continue' }] },
      120_000,
    );
    if (response.stopReason !== 'end_turn') throw new Error('the resumed session did not accept a prompt');
    const reply = second
      .sessionUpdates()
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content?.text ?? '')
      .join('');
    if (!reply.includes('resumed reply')) throw new Error('the resumed session did not stream its reply');
    ok('the resumed session accepted a prompt and streamed its reply');
  } finally {
    await second.close();
    await provider.close();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

await turnScenario();
await cancelScenario();
await terminalScenario();
await terminalDeltaScenario();
await v2Scenario();
await surfaceScenario();
await promptContentScenario();
await planScenario();
await commandScenario();
await suggestionScenario();
await goalExtensionScenario();
await mcpScenario();
await mcpAcpScenario();
await steeringScenario();
await cancelRequestScenario();
await cancelDuringPermissionScenario();
await lifecycleScenario();
await replayPlanScenario();
await loadScenario();
ok('end-to-end: turn, stream, cancel, tool card, shadow terminal, load, surface, prompt content');