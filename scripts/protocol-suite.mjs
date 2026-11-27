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


// --- session positive paths ------------------------------------------------

test('session/load replays history and accepts a prompt', async () => {
  const provider = await startFakeProvider({
    script: [{ kind: 'text', text: 'first answer' }, { kind: 'text', text: 'resumed answer' }],
  });
  const homeDir = writeFakeHome({ baseUrl: provider.baseUrl });
  const workDir = mkdtempSync(join(tmpdir(), 'kimi-acp-suite-'));
  let sessionId;
  const first = spawnAgent(mainPath, { homeDir, env: { KIMI_ACP_DEBUG: '1' } });
  try {
    await boot(first);
    sessionId = await newSession(first, workDir);
    await prompt(first, sessionId, 'first question');
  } finally {
    await first.close();
  }
  const second = spawnAgent(mainPath, { homeDir, env: { KIMI_ACP_DEBUG: '1' } });
  try {
    await boot(second);
    await second.request('session/load', { sessionId, cwd: workDir, mcpServers: [] }, 120_000);
    const replayed = updates(second)
      .filter(
        (update) =>
          update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'user_message_chunk',
      )
      .map((update) => update.content?.text ?? '')
      .join('\n');
    if (!replayed.includes('first question') || !replayed.includes('first answer')) {
      throw new Error(`replay missed history: ${replayed.slice(0, 200)}`);
    }
    const response = await prompt(second, sessionId, 'second question');
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
    if (!lastText(second).includes('resumed answer')) throw new Error('the resumed session did not stream');
  } finally {
    await second.close();
    await provider.close();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('session/fork yields a working session and delete removes it', async () => {
  await withAgent({ script: [{ kind: 'text', text: 'one' }, { kind: 'text', text: 'two' }] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    await prompt(agent, sessionId, 'first');
    const forked = await agent.request('session/fork', { sessionId, cwd: workDir, mcpServers: [] }, 60_000);
    if (forked.sessionId === sessionId) throw new Error('fork returned the same session');
    await prompt(agent, forked.sessionId, 'second');
    const listed = await agent.request('session/list', {});
    if (!listed.sessions.some((session) => session.sessionId === forked.sessionId)) {
      throw new Error('session/list does not include the fork');
    }
    await agent.request('session/delete', { sessionId: forked.sessionId }, 30_000);
    const after = await agent.request('session/list', {});
    if (after.sessions.some((session) => session.sessionId === forked.sessionId)) {
      throw new Error('session/delete left the fork listed');
    }
  });
});

test('a prompt after session/close is rejected', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    await agent.request('session/close', { sessionId }, 10_000);
    await expectReject(prompt(agent, sessionId, 'hello'), 'a prompt after close');
  });
});

// --- MCP -------------------------------------------------------------------

test('a declared MCP server reaches the model', async () => {
  await withAgent(
    {
      script: [
        { kind: 'tool', id: 'call_mcp', name: 'mcp__echo__echo', arguments: JSON.stringify({ text: 'mcp-suite' }) },
        { kind: 'text', text: 'done' },
      ],
    },
    async ({ agent, workDir }) => {
      await boot(agent);
      const created = await agent.request('session/new', {
        cwd: workDir,
        mcpServers: [
          {
            name: 'echo',
            command: process.execPath,
            args: [join(repoRoot, 'scripts', 'lib', 'mcp-echo-server.mjs')],
            env: [],
          },
        ],
      });
      const sessionId = created.sessionId;
      await waitFor(
        () => /echo\s+\[connected\]/.test(lastText(agent)),
        'the MCP server to connect',
        20_000,
      ).catch(() => undefined);
      // /mcp is a local command; retry until the server is connected.
      let listed = '';
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const { text } = await runCommand(agent, sessionId, '/mcp');
        listed = text;
        if (/echo\s+\[connected\]/.test(listed)) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      }
      if (!/echo\s+\[connected\]/.test(listed)) throw new Error(`MCP never connected: ${listed.slice(-200)}`);
      const response = await prompt(agent, sessionId, 'use the echo tool', 120_000);
      if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
      const output = updates(agent)
        .filter((update) => update.sessionUpdate === 'tool_call_update')
        .map((update) => JSON.stringify(update.content ?? ''))
        .join('\\n');
      if (!output.includes('mcp-suite')) throw new Error('the MCP tool result did not come back');
    },
  );
});

test('a client-hosted MCP server reaches the model (v2)', async () => {
  await withAgent(
    {
      script: [
        { kind: 'tool', id: 'call_acp_mcp', name: 'mcp__acp-echo__echo', arguments: JSON.stringify({ text: 'acp-suite' }) },
        { kind: 'text', text: 'done' },
      ],
    },
    async ({ agent, workDir }) => {
      await boot(agent, { protocolVersion: 2 });
      const methods = [];
      agent.onRequest('mcp/connect', (params) => {
        methods.push('connect');
        return { connectionId: `conn-${params.serverId}` };
      });
      agent.onRequest('mcp/message', (params) => {
        methods.push(params.method);
        if (params.method === 'initialize') {
          return {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'acp-echo', version: '1' },
          };
        }
        if (params.method === 'tools/list') {
          return {
            tools: [
              {
                name: 'echo',
                description: 'Echo',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
              },
            ],
          };
        }
        if (params.method === 'tools/call') {
          return { content: [{ type: 'text', text: String(params.params?.arguments?.text ?? '') }], isError: false };
        }
        return {};
      });
      const created = await agent.request('session/new', {
        cwd: workDir,
        mcpServers: [{ type: 'acp', name: 'acp-echo', serverId: 'srv-suite' }],
      });
      const response = await agent.request(
        'session/prompt',
        { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'use the tool' }] },
        120_000,
      );
      if (response.stopReason !== undefined) throw new Error('v2 prompt carried a stopReason');
      for (const expected of ['connect', 'initialize', 'tools/list', 'tools/call']) {
        if (!methods.includes(expected)) throw new Error(`missing MCP-over-ACP method: ${expected}`);
      }
      const output = updates(agent)
        .filter((update) => update.sessionUpdate === 'tool_call_update')
        .map((update) => JSON.stringify(update.content ?? ''))
        .join('\\n');
      if (!output.includes('acp-suite')) throw new Error('the hosted MCP result did not come back');
    },
  );
});

// --- goal and steering -----------------------------------------------------

test('_session/goal opens and closes the goal card', async () => {
  await withAgent(
    { script: [{ kind: 'text', text: 'goal continued' }] },
    async ({ agent, workDir }) => {
      await boot(agent);
      const sessionId = await newSession(agent, workDir);
      await agent.request('_session/goal', { sessionId, action: 'set', objective: 'suite objective' });
      await waitFor(
        () => updates(agent).some((update) => String(update.toolCallId ?? '').startsWith('goal:')),
        'the goal card',
      );
      await agent.request('_session/goal', { sessionId, action: 'clear' });
      await waitFor(
        () =>
          updates(agent).some(
            (update) =>
              String(update.toolCallId ?? '').startsWith('goal:') &&
              update.status === 'completed' &&
              JSON.stringify(update.content ?? '').includes('Goal cancelled'),
          ),
        'the cleared goal card',
      );
    },
  );
});

test('_session/steering injects into a running turn and reports promptRequired when idle', async () => {
  await withAgent(
    { script: [{ kind: 'text', text: 'slow' }, { kind: 'text', text: 'after' }], delayMs: 3_000 },
    async ({ agent, workDir }) => {
      await boot(agent);
      const sessionId = await newSession(agent, workDir);
      const running = prompt(agent, sessionId, 'start');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
      const injected = await agent.request(
        '_session/steering',
        { sessionId, prompt: [{ type: 'text', text: 'also this' }] },
        30_000,
      );
      if (injected.outcome !== 'injected') throw new Error(`outcome ${injected.outcome}`);
      await running;
      const idle = await agent.request(
        '_session/steering',
        { sessionId, prompt: [{ type: 'text', text: 'later' }], _meta: { steering: { idleBehavior: 'promptRequired' } } },
        30_000,
      );
      if (idle.outcome !== 'promptRequired') throw new Error(`idle outcome ${idle.outcome}`);
    },
  );
});

test('a prompt during a run is steered, not rejected', async () => {
  await withAgent(
    { script: [{ kind: 'text', text: 'slow' }, { kind: 'text', text: 'second' }], delayMs: 3_000 },
    async ({ agent, workDir }) => {
      await boot(agent);
      const sessionId = await newSession(agent, workDir);
      const running = prompt(agent, sessionId, 'start');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
      const steered = await prompt(agent, sessionId, 'and this');
      if (steered.stopReason !== 'end_turn') throw new Error(`steered stopReason ${steered.stopReason}`);
      if (!lastText(agent).includes('Message steered')) throw new Error('no steering note');
      await running;
    },
  );
});

// --- permissions -----------------------------------------------------------

test('approve for this session covers later calls', async () => {
  await withAgent(
    {
      script: [
        { kind: 'tool', id: 'call_one', name: 'Bash', arguments: JSON.stringify({ command: 'rm -rf /tmp/kimi-acp-suite-one' }) },
        { kind: 'tool', id: 'call_two', name: 'Bash', arguments: JSON.stringify({ command: 'rm -rf /tmp/kimi-acp-suite-one' }) },
        { kind: 'text', text: 'done' },
      ],
    },
    async ({ agent, workDir }) => {
      await boot(agent);
      agent.onRequest('session/request_permission', () => ({
        outcome: { outcome: 'selected', optionId: 'approve_session' },
      }));
      const sessionId = await newSession(agent, workDir);
      const response = await prompt(agent, sessionId, 'run both', 180_000);
      if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
      const requests = agent.requestsOf('session/request_permission').length;
      if (requests !== 1) throw new Error(`expected one permission request, got ${requests}`);
    },
  );
});

test('cancelling with an open permission dialog settles cancelled', async () => {
  await withAgent(
    { script: [{ kind: 'tool', id: 'call_gate', name: 'Bash', arguments: JSON.stringify({ command: 'rm -rf /tmp/kimi-acp-suite-gate' }) }] },
    async ({ agent, workDir }) => {
      await boot(agent);
      const pending = [];
      agent.onRequest('session/request_permission', () => new Promise((resolvePromise) => {
        pending.push(resolvePromise);
      }));
      const sessionId = await newSession(agent, workDir);
      const running = prompt(agent, sessionId, 'run it');
      await waitFor(() => pending.length > 0, 'the permission request');
      agent.notify('session/cancel', { sessionId });
      pending[0]({ outcome: { outcome: 'cancelled' } });
      const response = await running;
      if (response.stopReason !== 'cancelled') throw new Error(`stopReason ${response.stopReason}`);
    },
  );
});

// --- config options and modes ---------------------------------------------

test('set_config_option switches the model and rejects unknown ids', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const configured = await agent.request('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'fake',
    });
    const model = (configured.configOptions ?? []).find((option) => option.id === 'model');
    if (model?.currentValue !== 'fake') throw new Error('the model option did not change');
    if (!updates(agent).some((update) => update.sessionUpdate === 'config_option_update')) {
      throw new Error('no config_option_update');
    }
    await expectReject(
      agent.request('session/set_config_option', { sessionId, configId: 'nope', value: 'x' }),
      'an unknown config option',
    );
    await expectReject(
      agent.request('session/set_config_option', { sessionId, configId: 'model', value: 'no-such-model' }, 30_000),
      'an unknown model alias',
    );
  });
});

test('set_mode switches plan mode and rejects unknown modes', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    await agent.request('session/set_mode', { sessionId, modeId: 'plan' });
    const modes = updates(agent)
      .filter((update) => update.sessionUpdate === 'current_mode_update')
      .map((update) => update.currentModeId);
    if (!modes.includes('plan')) throw new Error('no plan mode update');
    await agent.request('session/set_mode', { sessionId, modeId: 'default' });
    await expectReject(
      agent.request('session/set_mode', { sessionId, modeId: 'warp' }),
      'an unknown mode',
    );
  });
});

// --- edge cases ------------------------------------------------------------

test('malformed prompt params are rejected', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    await expectReject(
      agent.request('session/prompt', { sessionId, prompt: 'not-an-array' }),
      'a malformed prompt',
    );
    await expectReject(
      agent.request('session/prompt', { sessionId: 7, prompt: [{ type: 'text', text: 'x' }] }),
      'a numeric sessionId',
    );
  });
});

test('cancel then a fresh prompt works', async () => {
  await withAgent(
    { script: [{ kind: 'text', text: 'slow' }, { kind: 'text', text: 'recovered' }], delayMs: 20_000 },
    async ({ agent, workDir }) => {
      await boot(agent);
      const sessionId = await newSession(agent, workDir);
      const running = prompt(agent, sessionId, 'start');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      agent.notify('session/cancel', { sessionId });
      const cancelled = await running;
      if (cancelled.stopReason !== 'cancelled') throw new Error('the first prompt was not cancelled');
      const before = updates(agent).filter((update) => update.sessionUpdate === 'agent_message_chunk').length;
      const response = await prompt(agent, sessionId, 'again');
      if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
      const after = updates(agent).filter((update) => update.sessionUpdate === 'agent_message_chunk').length;
      if (after <= before) throw new Error('the second prompt produced no output');
    },
  );
});

test('/init and /undo answer without crashing', async () => {
  await withAgent({ script: [{ kind: 'text', text: 'generated' }] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const init = await runCommand(agent, sessionId, '/init');
    const initText = init.text.toLowerCase();
    if (!initText.includes('agents.md') && !initText.includes('command failed')) {
      throw new Error(`/init answered ${init.text.slice(0, 120)}`);
    }
    const undo = await runCommand(agent, sessionId, '/undo 1');
    if (!/undid|command failed/i.test(undo.text)) throw new Error(`/undo answered ${undo.text.slice(0, 120)}`);
    const logout = await runCommand(agent, sessionId, '/logout');
    if (!/signed out|command failed/i.test(logout.text)) throw new Error(`/logout answered ${logout.text.slice(0, 120)}`);
  });
});

test('session/new accepts additional directories', async () => {
  await withAgent({ script: [{ kind: 'text', text: 'ok' }] }, async ({ agent, workDir }) => {
    await boot(agent);
    const extra = mkdtempSync(join(tmpdir(), 'kimi-acp-extra-'));
    try {
      const created = await agent.request('session/new', {
        cwd: workDir,
        additionalDirectories: [extra],
        mcpServers: [],
      });
      const response = await prompt(agent, created.sessionId, 'hello');
      if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
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
