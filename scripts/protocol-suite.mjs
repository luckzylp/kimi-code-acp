#!/usr/bin/env node
/**
 * Protocol + command conformance suite.
 *
 * One case per behaviour a client exercises, run against a real engine with a
 * fake provider: ACP handshake, session lifecycle, prompts, cancellation,
 * permissions, shadow terminals, the TUI command surface, and the v2 draft.
 * The shapes asserted here are derived from Zed's client
 * (docs/zed-acp-behavior.md) and from the ACP schemas.
 *
 *   node scripts/protocol-suite.mjs [filter]
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnAgent } from './lib/acp-client.mjs';
import { writeFakeHome } from './lib/fake-home.mjs';
import { startFakeProvider } from './lib/fake-provider.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainPath = join(repoRoot, 'packages', 'kimi-acp', 'dist', 'main.mjs');
const filter = process.argv[2];

const failures = [];
let passed = 0;

function ok(name) {
  process.stderr.write(`[suite] ok ${name}\n`);
}
function fail(name, error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[suite] FAIL ${name}: ${message}\n`);
  failures.push(name);
}

/** Zed's client capabilities, as `client_capabilities_for_agent` builds them. */
function zedCapabilities(extra = {}) {
  return {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
    auth: { terminal: true },
    session: { configOptions: { boolean: {} }, compaction: {}, notices: {} },
    elicitation: { form: {}, url: {} },
    _meta: { terminal_output: true, 'terminal-auth': true },
    ...extra,
  };
}

async function withAgent(options, body) {
  const provider = await startFakeProvider({
    script: options.script ?? [{ kind: 'text', text: 'ok' }],
    delayMs: options.delayMs,
  });
  const homeDir = writeFakeHome({ baseUrl: provider.baseUrl });
  const workDir = mkdtempSync(join(tmpdir(), 'kimi-acp-suite-'));
  const agent = spawnAgent(mainPath, {
    homeDir,
    env: { KIMI_ACP_DEBUG: '1', ...(options.env ?? {}) },
  });
  try {
    await body({ agent, provider, workDir });
  } finally {
    await agent.close();
    await provider.close();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

function updates(agent) {
  return agent.sessionUpdates();
}

function lastText(agent) {
  return updates(agent)
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => update.content?.text ?? '')
    .join('\n');
}

async function waitFor(predicate, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function expectReject(promise, what) {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error(`expected ${what} to be rejected`);
}

async function boot(agent, { capabilities = zedCapabilities(), protocolVersion = 1, info } = {}) {
  await agent.request('initialize', {
    protocolVersion,
    ...(protocolVersion === 2 ? { info: info ?? { name: 'zed-suite', version: '1.29.3' } } : {}),
    clientCapabilities: capabilities,
  });
  agent.onRequest('session/request_permission', () => ({
    outcome: { outcome: 'selected', optionId: 'approve_once' },
  }));
}

async function newSession(agent, workDir) {
  const created = await agent.request('session/new', { cwd: workDir, mcpServers: [] });
  return created.sessionId;
}

async function prompt(agent, sessionId, text, timeoutMs = 60_000) {
  return agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs);
}

async function runCommand(agent, sessionId, text) {
  const before = updates(agent).filter((u) => u.sessionUpdate === 'agent_message_chunk').length;
  const response = await prompt(agent, sessionId, text, 30_000);
  const textOut = updates(agent)
    .filter((u) => u.sessionUpdate === 'agent_message_chunk')
    .slice(before)
    .map((u) => u.content?.text ?? '')
    .join('\n');
  return { response, text: textOut };
}

const cases = [];
function test(name, run) {
  cases.push({ name, run });
}

// --- handshake -------------------------------------------------------------

test('initialize (v1) advertises the agent surface', async () => {
  await withAgent({ script: [] }, async ({ agent }) => {
    const init = await agent.request('initialize', {
      protocolVersion: 1,
      clientInformation: undefined,
      clientCapabilities: zedCapabilities(),
    });
    if (init.protocolVersion !== 1) throw new Error(`protocolVersion ${init.protocolVersion}`);
    const caps = init.agentCapabilities ?? {};
    if (caps.loadSession !== true) throw new Error('loadSession is not advertised');
    if (caps.promptCapabilities?.image !== true) throw new Error('image prompts are not advertised');
    if (caps.mcpCapabilities?.http !== true) throw new Error('http MCP is not advertised');
    const login = (init.authMethods ?? []).find((method) => method.id === 'login');
    if (login === undefined || login.type !== 'terminal') throw new Error('terminal login is not advertised');
  });
});

test('initialize answers the latest supported version for a newer client', async () => {
  await withAgent({ script: [] }, async ({ agent }) => {
    const init = await agent.request('initialize', {
      protocolVersion: 2,
      info: { name: 'zed', version: '1.29.3' },
      clientCapabilities: zedCapabilities(),
    });
    if (init.protocolVersion !== 2) throw new Error(`protocolVersion ${init.protocolVersion}`);
    if (init.info?.name === undefined) throw new Error('no agent info');
  });
});

test('unknown methods are rejected, not ignored', async () => {
  await withAgent({ script: [] }, async ({ agent }) => {
    await boot(agent);
    await expectReject(agent.request('session/explode', {}, 5_000), 'session/explode');
  });
});

// --- session lifecycle -----------------------------------------------------

test('session/new returns a session and session/list shows it', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const listed = await agent.request('session/list', {});
    const entry = (listed.sessions ?? []).find((session) => session.sessionId === sessionId);
    if (entry === undefined) throw new Error('session/list does not include the new session');
    if (entry.cwd !== workDir) throw new Error(`cwd mismatch: ${entry.cwd}`);
  });
});

test('session/new with a missing cwd is rejected', async () => {
  await withAgent({ script: [] }, async ({ agent }) => {
    await boot(agent);
    await expectReject(agent.request('session/new', {}, 5_000), 'session/new without cwd');
  });
});

test('session/new with an unusable cwd is rejected', async () => {
  await withAgent({ script: [] }, async ({ agent }) => {
    await boot(agent);
    await expectReject(
      agent.request('session/new', { cwd: '/definitely/not/a/directory', mcpServers: [] }, 10_000),
      'session/new with a bad cwd',
    );
  });
});

test('session/load and resume of an unknown id are rejected', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    await expectReject(
      agent.request('session/load', { sessionId: 'session_missing', cwd: workDir, mcpServers: [] }, 10_000),
      'session/load of a missing session',
    );
    await expectReject(
      agent.request('session/resume', { sessionId: 'session_missing', cwd: workDir, mcpServers: [] }, 10_000),
      'session/resume of a missing session',
    );
  });
});

test('session/fork and delete of an unknown id are rejected', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    await expectReject(
      agent.request('session/fork', { sessionId: 'session_missing', cwd: workDir, mcpServers: [] }, 10_000),
      'session/fork of a missing session',
    );
    await expectReject(
      agent.request('session/delete', { sessionId: 'session_missing' }, 10_000),
      'session/delete of a missing session',
    );
  });
});

test('session/close of an unknown id is a no-op', async () => {
  await withAgent({ script: [] }, async ({ agent }) => {
    await boot(agent);
    const response = await agent.request('session/close', { sessionId: 'session_missing' }, 5_000);
    if (response === undefined) throw new Error('session/close returned nothing');
  });
});

// --- prompts ---------------------------------------------------------------

test('a text prompt streams one message and settles end_turn', async () => {
  await withAgent({ script: [{ kind: 'text', text: 'hello there' }] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const response = await prompt(agent, sessionId, 'hi');
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
    const chunks = updates(agent).filter((update) => update.sessionUpdate === 'agent_message_chunk');
    if (chunks.length === 0) throw new Error('no agent message chunk');
    if (typeof chunks[0].messageId !== 'string') throw new Error('chunk has no messageId');
    if (lastText(agent) !== 'hello there') throw new Error(`text ${JSON.stringify(lastText(agent))}`);
  });
});

test('an empty prompt is rejected', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    await expectReject(
      agent.request('session/prompt', { sessionId, prompt: [] }, 5_000),
      'an empty prompt',
    );
  });
});

test('a prompt to an unknown session is rejected', async () => {
  await withAgent({ script: [] }, async ({ agent }) => {
    await boot(agent);
    await expectReject(prompt(agent, 'session_missing', 'hi'), 'a prompt to a missing session');
  });
});

test('an image prompt reaches the model as a data URL', async () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await withAgent({ script: [{ kind: 'text', text: 'seen' }] }, async ({ agent, provider, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const response = await agent.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'image', data: png, mimeType: 'image/png' }] },
      60_000,
    );
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
    if (!/data:image\/png/.test(provider.requests[0]?.body ?? '')) throw new Error('no image in the model request');
  });
});

test('a resource_link to a missing file still answers', async () => {
  await withAgent({ script: [{ kind: 'text', text: 'ok' }] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const response = await agent.request(
      'session/prompt',
      {
        sessionId,
        prompt: [
          { type: 'text', text: 'read it' },
          { type: 'resource_link', uri: 'file:///definitely/not/here.md', name: 'here.md' },
        ],
      },
      60_000,
    );
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
  });
});

test('session/cancel settles the run as cancelled', async () => {
  await withAgent({ script: [{ kind: 'text', text: 'slow' }], delayMs: 20_000 }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const pending = prompt(agent, sessionId, 'go');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    agent.notify('session/cancel', { sessionId });
    const response = await pending;
    if (response.stopReason !== 'cancelled') throw new Error(`stopReason ${response.stopReason}`);
  });
});

test('$/cancel_request cancels the request it names, unknown ids are ignored', async () => {
  await withAgent({ script: [{ kind: 'text', text: 'slow' }, { kind: 'text', text: 'next' }], delayMs: 20_000 }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const { id, promise } = agent.beginRequest('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] }, 60_000);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    agent.notify('$/cancel_request', { requestId: 999_999 });
    agent.notify('$/cancel_request', { requestId: id });
    const response = await promise;
    if (response.stopReason !== 'cancelled') throw new Error(`stopReason ${response.stopReason}`);
  });
});

// --- permissions and terminals --------------------------------------------

test('an approved tool runs and mirrors its terminal', async () => {
  const command = 'echo suite-hello';
  await withAgent(
    {
      script: [
        { kind: 'tool', id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command }) },
        { kind: 'text', text: 'done' },
      ],
    },
    async ({ agent, workDir }) => {
      await boot(agent);
      const sessionId = await newSession(agent, workDir);
      const response = await prompt(agent, sessionId, 'run the command', 120_000);
      if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
      const toolUpdates = updates(agent).filter(
        (update) => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update',
      );
      const card = toolUpdates.find((update) => update.sessionUpdate === 'tool_call');
      const terminalId = card?._meta?.terminal_info?.terminal_id;
      if (typeof terminalId !== 'string') throw new Error('no _meta.terminal_info on the tool call');
      if (!card.content?.some((entry) => entry.type === 'terminal')) throw new Error('the card has no terminal content');
      const output = toolUpdates
        .map((update) => update._meta?.terminal_output)
        .filter((chunk) => chunk !== undefined)
        .map((chunk) => chunk.data)
        .join('');
      if (!output.includes('suite-hello')) throw new Error('terminal_output lacked the command output');
      const exit = toolUpdates.map((update) => update._meta?.terminal_exit).find((value) => value !== undefined);
      if (exit?.exit_code !== 0) throw new Error(`terminal_exit ${JSON.stringify(exit)}`);
      const completed = toolUpdates.some((update) => update.status === 'completed');
      if (!completed) throw new Error('the tool call never completed');
    },
  );
});

test('a rejected tool fails without running', async () => {
  await withAgent(
    { script: [{ kind: 'tool', id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command: 'rm -rf /tmp/kimi-acp-suite-reject' }) }, { kind: 'text', text: 'done' }] },
    async ({ agent, workDir }) => {
      await boot(agent);
      agent.onRequest('session/request_permission', () => ({
        outcome: { outcome: 'selected', optionId: 'reject_once' },
      }));
      const sessionId = await newSession(agent, workDir);
      await prompt(agent, sessionId, 'run it');
      const failed = updates(agent).some(
        (update) => update.sessionUpdate === 'tool_call_update' && update.status === 'failed',
      );
      if (!failed) throw new Error('the rejected tool call did not fail');
    },
  );
});

// --- commands --------------------------------------------------------------

const commandCases = [
  ['/help lists commands', '/help', (text) => text.includes('/status')],
  ['/status reports the model', '/status', (text) => text.includes('Model:') && text.includes('Permission:')],
  ['/usage answers', '/usage', (text) => text.length > 0],
  ['/goal status without a goal', '/goal status', (text) => /No goal/i.test(text)],
  ['/swarm on enables swarm mode', '/swarm on', (text) => text.includes('Swarm mode on')],
  ['/swarm off disables swarm mode', '/swarm off', (text) => text.includes('Swarm mode off')],
  ['/permission lists the mode', '/permission', (text) => text.includes('Permission:')],
  ['/permission switches to plan', '/permission plan', (text) => text.includes('Mode set to plan')],
  ['/permission rejects unknown modes', '/permission warp', (text) => text.includes('Usage: /permission')],
  ['/model lists models', '/model', (text) => text.includes('fake')],
  ['/model sets a model', '/model fake', (text) => text.includes('Model set to fake')],
  ['/effort reports the level', '/effort', (text) => text.includes('Thinking effort')],
  ['/title sets a title', '/title Suite Title', (text) => text.includes('Suite Title')],
  ['/title without text explains usage', '/title', (text) => text.includes('Usage: /title')],
  ['/add-dir adds a directory', '/add-dir /tmp', (text) => text.includes('Added /tmp')],
  ['/add-dir without a path explains usage', '/add-dir', (text) => text.includes('Usage: /add-dir')],
  ['/tasks lists background tasks', '/tasks', (text) => /background tasks|\[/i.test(text)],
  ['/mcp lists servers', '/mcp', (text) => /MCP server|No MCP/i.test(text)],
  ['/plugins lists plugins', '/plugins', (text) => /plugin|No plugins/i.test(text)],
  ['/compact reports a refusal as a notice', '/compact', (text) => /Compaction requested|Command failed/i.test(text)],
  ['/help does not call the model', '/help', () => true],
];

for (const [name, command, check] of commandCases) {
  test(name, async () => {
    await withAgent({ script: [{ kind: 'text', text: 'fallback' }] }, async ({ agent, provider, workDir }) => {
      await boot(agent);
      const sessionId = await newSession(agent, workDir);
      const before = provider.requests.length;
      const { response, text } = await runCommand(agent, sessionId, command);
      if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
      if (!check(text)) throw new Error(`unexpected answer: ${JSON.stringify(text.slice(0, 200))}`);
      if (command !== '/compact' && provider.requests.length !== before) {
        throw new Error('a local command reached the model');
      }
    });
  });
}

test('/swarm <task> submits the task', async () => {
  await withAgent({ script: [{ kind: 'text', text: 'swarmed' }] }, async ({ agent, provider, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const { response, text } = await runCommand(agent, sessionId, '/swarm do the thing');
    if (!text.includes('Swarm mode on')) throw new Error('no swarm notice');
    if (provider.requests.length === 0) throw new Error('the task was not submitted');
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
  });
});

test('/model with an unknown alias reports a notice', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const { response, text } = await runCommand(agent, sessionId, '/model no-such-model');
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
    if (!/Command failed/i.test(text)) throw new Error(`unexpected answer: ${text.slice(0, 200)}`);
  });
});

test('/goal pause without a goal reports a notice', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const { response, text } = await runCommand(agent, sessionId, '/goal pause');
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
    if (!/Command failed/i.test(text)) throw new Error(`unexpected answer: ${text.slice(0, 200)}`);
  });
});

test('an unknown slash command becomes a prompt', async () => {
  await withAgent({ script: [{ kind: 'text', text: 'handled as text' }] }, async ({ agent, provider, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const response = await prompt(agent, sessionId, '/not-a-command hello');
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
    if (provider.requests.length === 0) throw new Error('the text did not reach the model');
  });
});

// --- v2 draft --------------------------------------------------------------

test('v2 initialize / session / prompt / cancel', async () => {
  await withAgent({ script: [{ kind: 'text', text: 'v2 answer' }, { kind: 'text', text: 'slow' }], delayMs: 20 }, async ({ agent, workDir }) => {
    await boot(agent, { protocolVersion: 2 });
    const created = await agent.request('session/new', { cwd: workDir });
    if (typeof created.sessionId !== 'string') throw new Error('no v2 sessionId');
    const response = await agent.request(
      'session/prompt',
      { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'hi' }] },
      60_000,
    );
    if (response.stopReason !== undefined) throw new Error('v2 prompt carried a v1 stopReason');
    const states = updates(agent).filter((u) => u.sessionUpdate === 'state_update').map((u) => u.state);
    if (!states.includes('running') || !states.includes('idle')) throw new Error(`states ${states.join(',')}`);

    const slow = agent.beginRequest('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'slow' }],
    }, 60_000);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    agent.notify('session/cancel', { sessionId: created.sessionId });
    const cancelled = await slow.promise;
    if (cancelled.stopReason !== undefined) throw new Error('v2 cancel returned a stopReason');
  });
});

test('v2 set_config_option type id and providers/list', async () => {
  await withAgent({ script: [{ kind: 'text', text: 'ok' }] }, async ({ agent, workDir }) => {
    await boot(agent, { protocolVersion: 2 });
    const created = await agent.request('session/new', { cwd: workDir });
    const configured = await agent.request('session/set_config_option', {
      sessionId: created.sessionId,
      configId: 'mode',
      type: 'id',
      value: 'default',
    });
    if (!Array.isArray(configured.configOptions)) throw new Error('no config options');
    const providers = await agent.request('providers/list', {});
    if (!Array.isArray(providers.providers)) throw new Error('no providers array');
    await expectReject(
      agent.request('session/set_config_option', {
        sessionId: created.sessionId,
        configId: 'nope',
        type: 'id',
        value: 'x',
      }, 10_000),
      'an unknown v2 config option',
    );
  });
});

test('v2 document notifications are ignored', async () => {
  await withAgent({ script: [{ kind: 'text', text: 'ok' }] }, async ({ agent, workDir }) => {
    await boot(agent, { protocolVersion: 2 });
    const created = await agent.request('session/new', { cwd: workDir });
    agent.notify('document/didOpen', {
      sessionId: created.sessionId,
      uri: 'file:///tmp/x.ts',
      languageId: 'typescript',
      version: 1,
      text: 'let x = 1;',
    });
    const response = await agent.request(
      'session/prompt',
      { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'hi' }] },
      60_000,
    );
    if (response.stopReason !== undefined) throw new Error('document notification broke the session');
  });
});

// --- runner ----------------------------------------------------------------

for (const { name, run } of cases) {
  if (filter !== undefined && !name.includes(filter)) continue;
  try {
    await run();
    passed += 1;
    ok(name);
  } catch (error) {
    fail(name, error);
  }
}

process.stderr.write(`\n[suite] ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const name of failures) process.stderr.write(`[suite] failed: ${name}\n`);
  process.exit(1);
}