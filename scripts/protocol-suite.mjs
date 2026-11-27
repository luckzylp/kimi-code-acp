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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnAgent } from './lib/acp-client.mjs';
import { writeFakeHome } from './lib/fake-home.mjs';
import { startFakeProvider } from './lib/fake-provider.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainPath = join(repoRoot, 'packages', 'kimi-code-acp', 'dist', 'main.mjs');
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
  const homeDir = writeFakeHome({ baseUrl: provider.baseUrl, autoSessionTitle: options.autoSessionTitle });
  options.setupHome?.(homeDir);
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

function expectModes(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`modes ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
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
  const initialized = await agent.request('initialize', {
    protocolVersion,
    ...(protocolVersion === 2
      ? { info: info ?? { name: 'zed-suite', version: '1.29.3' }, capabilities }
      : { clientCapabilities: capabilities }),
  });
  agent.onRequest('session/request_permission', () => ({
    outcome: { outcome: 'selected', optionId: 'approve_once' },
  }));
  return initialized;
}

async function newSession(agent, workDir) {
  const created = await agent.request('session/new', { cwd: workDir, mcpServers: [] });
  return created.sessionId;
}

async function prompt(agent, sessionId, text, timeoutMs = 60_000) {
  return agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs);
}

async function runCommand(agent, sessionId, text) {
  const slice = (list) =>
    list
      .filter((u) => u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'notice')
      .map((u) =>
        u.sessionUpdate === 'notice'
          ? [u.title, u.description].filter((part) => typeof part === 'string').join(': ')
          : (u.content?.text ?? ''),
      )
      .join('\n');
  const before = slice(updates(agent)).length;
  const response = await prompt(agent, sessionId, text, 30_000);
  return { response, text: slice(updates(agent)).slice(before) };
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
  ['/status reports the model', '/status', (text) => text.includes('Model:') && text.includes('Permission:')],
  ['/usage answers', '/usage', (text) => text.length > 0],
  ['/goal status without a goal', '/goal status', (text) => /No goal/i.test(text)],
  ['/swarm on enables swarm mode', '/swarm on', (text) => text.includes('Swarm mode on')],
  ['/swarm off disables swarm mode', '/swarm off', (text) => text.includes('Swarm mode off')],
  ['/title sets a title', '/title Suite Title', (text) => text.includes('Suite Title')],
  ['/title without text explains usage', '/title', (text) => text.includes('Usage: /title')],
  ['/add-dir adds a directory', '/add-dir /tmp', (text) => text.includes('Added /tmp')],
  ['/add-dir without a path explains usage', '/add-dir', (text) => text.includes('Usage: /add-dir')],
  ['/tasks lists background tasks', '/tasks', (text) => /background tasks|\[/i.test(text)],
  ['/mcp lists servers', '/mcp', (text) => /MCP server|No MCP/i.test(text)],
  ['/compact reports a refusal as a notice', '/compact', (text) => /Compaction requested|Command failed/i.test(text)],
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

test('a prompt during a run is steered and settles with that turn', async () => {
  await withAgent(
    { script: [{ kind: 'text', text: 'slow' }, { kind: 'text', text: 'second' }], delayMs: 3_000 },
    async ({ agent, workDir }) => {
      await boot(agent);
      const sessionId = await newSession(agent, workDir);
      const running = prompt(agent, sessionId, 'start');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
      const startedAt = Date.now();
      const steered = await prompt(agent, sessionId, 'and this', 60_000);
      // The steered request must wait for the running turn, not return at once.
      if (Date.now() - startedAt < 1_000) throw new Error('the steered prompt returned before the turn ended');
      const first = await running;
      if (steered.stopReason !== first.stopReason) {
        throw new Error(`steered ${steered.stopReason} vs running ${first.stopReason}`);
      }
      if (!lastText(agent).includes('Message steered')) throw new Error('no steering note');
    },
  );
});

test('a cancel after steering settles only the steered prompt as cancelled', async () => {
  await withAgent(
    { script: [{ kind: 'text', text: 'slow' }], delayMs: 20_000 },
    async ({ agent, workDir }) => {
      await boot(agent);
      const sessionId = await newSession(agent, workDir);
      const running = prompt(agent, sessionId, 'start');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      const steered = prompt(agent, sessionId, 'and this', 60_000);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      agent.notify('session/cancel', { sessionId });
      const [first, second] = await Promise.all([running, steered]);
      // The engine ends the interrupted turn as `completed`; the cancel lands on
      // the steered message's own turn, so only that request reports `cancelled`.
      if (first.stopReason !== 'end_turn' || second.stopReason !== 'cancelled') {
        throw new Error(`running ${first.stopReason} / steered ${second.stopReason}`);
      }
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


// --- cursors and rewind ----------------------------------------------------

test('cursors are announced and rewind drops the turn', async () => {
  await withAgent(
    {
      script: [
        { kind: 'text', text: 'first answer' },
        { kind: 'text', text: 'second answer' },
        { kind: 'text', text: 'third answer' },
      ],
    },
    async ({ agent, provider, workDir }) => {
      const capabilities = zedCapabilities();
      capabilities.session.cursors = {};
      await boot(agent, { capabilities });
      const sessionId = await newSession(agent, workDir);
      await prompt(agent, sessionId, 'first question');
      await prompt(agent, sessionId, 'second question');

      const cursors = updates(agent).filter((update) => update.sessionUpdate === 'cursor_update');
      // The first prompt has no earlier entity to anchor to, so the second
      // prompt yields the first rewindable cursor (as in Clauck Code's v1 core).
      if (cursors.length < 1) throw new Error('no rewind cursor was announced');
      for (const cursor of cursors) {
        if (cursor.anchor?.type === undefined) throw new Error('cursor carries no anchor');
        if (!['before', 'after'].includes(cursor.anchor.position)) {
          throw new Error(`unexpected cursor position: ${cursor.anchor.position}`);
        }
        if (cursor.capabilities?.rewind === undefined) throw new Error('cursor does not announce rewind');
      }

      const rewound = await agent.request('_session/rewind', {
        sessionId,
        cursorId: cursors[0].cursorId,
      });
      if (rewound.rewound !== true) throw new Error(`rewind answered ${JSON.stringify(rewound)}`);

      await prompt(agent, sessionId, 'third question');
      const body = provider.requests.at(-1)?.body ?? '';
      if (!body.includes('third question')) throw new Error('the new prompt did not reach the model');
      if (body.includes('second question')) throw new Error('the rewound message is still in the context');
      if (body.includes('second answer')) throw new Error('the rewound answer is still in the context');

      await expectReject(
        agent.request('_session/rewind', { sessionId, cursorId: 'before:no-such-message' }),
        'an unknown cursor',
      );
    },
  );
});

test('rewind while a run is active reports busy', async () => {
  await withAgent(
    { script: [{ kind: 'text', text: 'slow' }, { kind: 'text', text: 'next' }], delayMs: 20_000 },
    async ({ agent, workDir }) => {
      const capabilities = zedCapabilities();
      capabilities.session.cursors = {};
      await boot(agent, { capabilities });
      const sessionId = await newSession(agent, workDir);
      await prompt(agent, sessionId, 'first');
      const running = agent.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: 'second' }] },
        60_000,
      );
      await waitFor(
        () => updates(agent).some((update) => update.sessionUpdate === 'cursor_update'),
        'a cursor for the second prompt',
      );
      const cursor = updates(agent).find((update) => update.sessionUpdate === 'cursor_update');
      if (cursor === undefined) throw new Error('no cursor for the second message');
      const rewound = await agent.request('_session/rewind', { sessionId, cursorId: cursor.cursorId });
      if (rewound.rewound !== false || rewound.reason !== 'busy') {
        throw new Error(`rewind answered ${JSON.stringify(rewound)}`);
      }
      agent.notify('session/cancel', { sessionId });
      await running;
    },
  );
});


// --- structured notices ----------------------------------------------------

test('a notices-capable client gets a structured command failure', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    const capabilities = zedCapabilities();
    capabilities.session.notices = {};
    await boot(agent, { capabilities });
    const sessionId = await newSession(agent, workDir);
    await prompt(agent, sessionId, '/compact');
    const notice = updates(agent).find((update) => update.sessionUpdate === 'notice');
    if (notice === undefined) throw new Error('no notice update was sent');
    if (notice.severity !== 'warning') throw new Error(`notice severity ${notice.severity}`);
    if (notice.title !== 'Command failed') throw new Error(`notice title ${notice.title}`);
    const message = updates(agent)
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content?.text ?? '')
      .join('');
    if (message.includes('Command failed')) throw new Error('the failure was also sent as a message');
  });
});

test('a client without notices gets the failure as a message', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    const capabilities = zedCapabilities();
    delete capabilities.session.notices;
    await boot(agent, { capabilities });
    const sessionId = await newSession(agent, workDir);
    await prompt(agent, sessionId, '/compact');
    if (updates(agent).some((update) => update.sessionUpdate === 'notice')) {
      throw new Error('a notice was sent to a client that does not render notices');
    }
    const message = updates(agent)
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content?.text ?? '')
      .join('');
    if (!message.includes('Command failed')) throw new Error('the failure was not sent as a message');
  });
});

test('v2 command failures are structured notices', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent, { protocolVersion: 2 });
    const created = await agent.request('session/new', { cwd: workDir });
    await agent.request(
      'session/prompt',
      { sessionId: created.sessionId, prompt: [{ type: 'text', text: '/compact' }] },
      30_000,
    );
    const notice = updates(agent).find((update) => update.sessionUpdate === 'notice');
    if (notice === undefined) throw new Error('no v2 notice update was sent');
    if (notice.severity !== 'warning') throw new Error(`v2 notice severity ${notice.severity}`);
  });
});


test('permission options carry the kinds Zed renders', async () => {
  await withAgent(
    {
      script: [
        { kind: 'tool', id: 'call_kinds', name: 'Bash', arguments: JSON.stringify({ command: 'rm -rf /tmp/kimi-acp-suite-kinds' }) },
        { kind: 'text', text: 'done' },
      ],
    },
    async ({ agent, workDir }) => {
      await boot(agent);
      const sessionId = await newSession(agent, workDir);
      const kinds = [];
      agent.onRequest('session/request_permission', (params) => {
        kinds.push(...(params.options ?? []).map((option) => option.kind));
        return { outcome: { outcome: 'selected', optionId: 'reject_once' } };
      });
      await prompt(agent, sessionId, 'run it', 120_000);
      for (const expected of ['allow_once', 'allow_always', 'reject_once']) {
        if (!kinds.includes(expected)) throw new Error(`missing permission kind: ${expected}`);
      }
    },
  );
});


// --- reload after rewind, concurrency and v2 errors -----------------------

test('rewind survives a reload: the dropped turn is not replayed', async () => {
  const provider = await startFakeProvider({
    script: [
      { kind: 'text', text: 'first answer' },
      { kind: 'text', text: 'second answer' },
    ],
  });
  const homeDir = writeFakeHome({ baseUrl: provider.baseUrl });
  const workDir = mkdtempSync(join(tmpdir(), 'kimi-acp-suite-'));
  let sessionId;
  const first = spawnAgent(mainPath, { homeDir, env: { KIMI_ACP_DEBUG: '1' } });
  try {
    const capabilities = zedCapabilities();
    capabilities.session.cursors = {};
    await boot(first, { capabilities });
    sessionId = await newSession(first, workDir);
    await prompt(first, sessionId, 'first question');
    await prompt(first, sessionId, 'second question');
    const cursor = first
      .sessionUpdates()
      .filter((update) => update.sessionUpdate === 'cursor_update')
      .at(-1);
    if (cursor === undefined) throw new Error('no cursor to rewind to');
    const rewound = await first.request('_session/rewind', { sessionId, cursorId: cursor.cursorId });
    if (rewound.rewound !== true) throw new Error('rewind failed');
  } finally {
    await first.close();
  }

  const second = spawnAgent(mainPath, { homeDir, env: { KIMI_ACP_DEBUG: '1' } });
  try {
    const capabilities = zedCapabilities();
    capabilities.session.cursors = {};
    await boot(second, { capabilities });
    await second.request('session/load', { sessionId, cwd: workDir, mcpServers: [] }, 120_000);
    const replayed = second
      .sessionUpdates()
      .filter(
        (update) =>
          update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'user_message_chunk',
      )
      .map((update) => update.content?.text ?? '')
      .join('\n');
    if (!replayed.includes('first question')) throw new Error('the kept turn is missing from the reload');
    if (replayed.includes('second question')) throw new Error('the rewound turn came back on reload');
    const cursors = second.sessionUpdates().filter((update) => update.sessionUpdate === 'cursor_update');
    if (cursors.length === 0) throw new Error('the reload announced no cursors');
    if (cursors[0].anchor?.type !== 'user_message') throw new Error('a replay cursor is not message-anchored');
    if (cursors[0].anchor.position !== 'before') throw new Error('a replay cursor is not a before-cursor');
  } finally {
    await second.close();
    await provider.close();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('two sessions run independently', async () => {
  await withAgent(
    {
      script: [
        { kind: 'text', text: 'alpha answer' },
        { kind: 'text', text: 'beta answer' },
      ],
      delayMs: 2_000,
    },
    async ({ agent, workDir }) => {
      await boot(agent);
      const alpha = await newSession(agent, workDir);
      const beta = await newSession(agent, workDir);
      const alphaPromise = prompt(agent, alpha, 'alpha question', 60_000);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      const betaPromise = prompt(agent, beta, 'beta question', 60_000);
      const [alphaResponse, betaResponse] = await Promise.all([alphaPromise, betaPromise]);
      if (alphaResponse.stopReason !== 'end_turn' || betaResponse.stopReason !== 'end_turn') {
        throw new Error('a concurrent session did not finish');
      }
      const textFor = (sessionId) =>
        agent.notifications
          .filter(
            (message) =>
              message.method === 'session/update' &&
              message.params.sessionId === sessionId &&
              message.params.update.sessionUpdate === 'agent_message_chunk',
          )
          .map((message) => message.params.update.content?.text ?? '')
          .join('');
      const alphaText = textFor(alpha);
      const betaText = textFor(beta);
      if (!alphaText.includes('alpha answer') || alphaText.includes('beta answer')) {
        throw new Error(`alpha session text: ${JSON.stringify(alphaText)}`);
      }
      if (!betaText.includes('beta answer') || betaText.includes('alpha answer')) {
        throw new Error(`beta session text: ${JSON.stringify(betaText)}`);
      }
    },
  );
});

test('unknown v2 methods are rejected', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent, { protocolVersion: 2 });
    await agent.request('session/new', { cwd: workDir });
    await expectReject(agent.request('session/explode', {}, 5_000), 'a v2 unknown method');
  });
});

// --- skills, resume, status ------------------------------------------------

test('a workspace skill is advertised and invocable', async () => {
  const marker = 'SUITE-SKILL-BODY-MARKER';
  await withAgent(
    {
      script: [{ kind: 'text', text: 'skill used' }],
      setupHome: (homeDir) => {
        const dir = join(homeDir, 'skills', 'suite-skill');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'SKILL.md'),
          `---\nname: suite-skill\ndescription: A skill the suite invokes.\n---\n\n# Suite skill\n\n${marker}\n`,
        );
      },
    },
    async ({ agent, provider, workDir }) => {
      await boot(agent);
      const sessionId = await newSession(agent, workDir);
      await waitFor(
        () =>
          updates(agent).some(
            (update) =>
              update.sessionUpdate === 'available_commands_update' &&
              (update.availableCommands ?? []).some((command) => command.name === 'suite-skill'),
          ),
        'the skill command',
      );
      const response = await prompt(agent, sessionId, '/suite-skill do the thing', 60_000);
      if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
      const body = provider.requests[0]?.body ?? '';
      if (!body.includes(marker)) throw new Error('the skill body was not activated');
    },
  );
});

test('session/resume binds without replaying history', async () => {
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
    await second.request('session/resume', { sessionId, cwd: workDir, mcpServers: [] }, 60_000);
    const replayed = second
      .sessionUpdates()
      .filter((update) => update.sessionUpdate === 'user_message_chunk' || update.sessionUpdate === 'agent_message_chunk')
      .length;
    if (replayed !== 0) throw new Error('session/resume replayed history');
    const response = await prompt(second, sessionId, 'second question');
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
    const text = second
      .sessionUpdates()
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content?.text ?? '')
      .join('');
    if (!text.includes('resumed answer')) throw new Error('the resumed session did not answer');
  } finally {
    await second.close();
    await provider.close();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('/status reflects plan and swarm modes', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    await agent.request('session/set_mode', { sessionId, modeId: 'plan' });
    const planned = await runCommand(agent, sessionId, '/status');
    if (!/Plan mode: on/.test(planned.text)) throw new Error(`/status after plan: ${planned.text}`);
    await agent.request('session/set_mode', { sessionId, modeId: 'default' });
    await runCommand(agent, sessionId, '/swarm on');
    const swarmed = await runCommand(agent, sessionId, '/status');
    if (!/Swarm mode: on/.test(swarmed.text)) throw new Error(`/status after swarm: ${swarmed.text}`);
  });
});

test('/add-dir with a missing path reports a notice', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const { response, text } = await runCommand(agent, sessionId, '/add-dir /definitely/not/here');
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
    if (!/Command failed|not found|does not exist|no such/i.test(text)) {
      throw new Error(`unexpected answer: ${text.slice(0, 200)}`);
    }
  });
});

// --- AIR extensions --------------------------------------------------------

function airCapabilities(capabilities = ['sessionIndex', 'sessionRename', 'goal']) {
  const caps = zedCapabilities();
  caps._meta = { ...caps._meta, jetbrains: { air: { version: 1, capabilities } } };
  return caps;
}

test('AIR clients get the AIR capability meta, others do not', async () => {
  await withAgent({ script: [] }, async ({ agent }) => {
    const air = await agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: airCapabilities(),
    });
    const ext = air._meta?.jetbrains?.air;
    if (ext === undefined) throw new Error('no jetbrains.air meta in the response');
    if (ext.version !== 1) throw new Error(`AIR version ${ext.version}`);
    if (!(ext.capabilities ?? []).includes('sessionRename')) {
      throw new Error(`AIR capabilities: ${JSON.stringify(ext.capabilities)}`);
    }
    if (!(ext.goal?.actions ?? []).includes('set')) throw new Error('goal actions are not advertised');
  });
});

test('non-AIR clients get no AIR meta', async () => {
  await withAgent({ script: [] }, async ({ agent }) => {
    const init = await agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: zedCapabilities(),
    });
    if (init._meta?.jetbrains !== undefined) throw new Error('AIR meta leaked to a non-AIR client');
  });
});

test('_session/rename sets the title', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent, { capabilities: airCapabilities() });
    const sessionId = await newSession(agent, workDir);
    await agent.request('_session/rename', { sessionId, title: 'Renamed by AIR' }, 10_000);
    await waitFor(
      () =>
        updates(agent).some(
          (update) => update.sessionUpdate === 'session_info_update' && update.title === 'Renamed by AIR',
        ),
      'the title update',
    );
    const listed = await agent.request('session/list', {});
    const entry = listed.sessions.find((session) => session.sessionId === sessionId);
    if (entry?.title !== 'Renamed by AIR') throw new Error(`session/list title: ${JSON.stringify(entry?.title)}`);
    await expectReject(
      agent.request('_session/rename', { sessionId, title: '   ' }, 5_000),
      'an empty rename title',
    );
  });
});

test('AIR goal updates carry the goal payload', async () => {
  await withAgent(
    { script: [{ kind: 'text', text: 'goal continued' }] },
    async ({ agent, workDir }) => {
      await boot(agent, { capabilities: airCapabilities() });
      const sessionId = await newSession(agent, workDir);
      await agent.request('_session/goal', { sessionId, action: 'set', objective: 'air objective' });
      await waitFor(
        () =>
          updates(agent).some(
            (update) =>
              update.sessionUpdate === 'session_info_update' &&
              update._meta?.jetbrains?.air?.goal?.objective === 'air objective',
          ),
        'the AIR goal payload',
      );
      await agent.request('_session/goal', { sessionId, action: 'clear' });
      await waitFor(
        () =>
          updates(agent).some(
            (update) =>
              update.sessionUpdate === 'session_info_update' &&
              update._meta?.jetbrains?.air?.goal === null,
          ),
        'the cleared AIR goal payload',
      );
    },
  );
});

// --- remaining surface -----------------------------------------------------

test('providers/set and providers/disable are rejected (v1 and v2)', async () => {
  await withAgent({ script: [] }, async ({ agent }) => {
    await boot(agent);
    await expectReject(agent.request('providers/set', { providerId: 'x', apiType: 'openai', baseUrl: 'https://example.test/v1' }, 5_000), 'v1 providers/set');
    await expectReject(agent.request('providers/disable', { providerId: 'x' }, 5_000), 'v1 providers/disable');
  });
  await withAgent({ script: [] }, async ({ agent }) => {
    await boot(agent, { protocolVersion: 2 });
    await expectReject(agent.request('providers/set', { providerId: 'x', apiType: 'openai', baseUrl: 'https://example.test/v1' }, 5_000), 'v2 providers/set');
    await expectReject(agent.request('providers/disable', { providerId: 'x' }, 5_000), 'v2 providers/disable');
  });
});

test('set_mode supports auto and yolo', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    for (const mode of ['auto', 'yolo', 'default']) {
      await agent.request('session/set_mode', { sessionId, modeId: mode });
      const modes = updates(agent)
        .filter((update) => update.sessionUpdate === 'current_mode_update')
        .map((update) => update.currentModeId);
      if (!modes.includes(mode)) throw new Error(`mode ${mode} was not applied`);
    }
  });
});

test('set_config_option accepts an advertised thinking level', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    const created = await agent.request('session/new', { cwd: workDir, mcpServers: [] });
    const thinking = (created.configOptions ?? []).find((option) => option.id === 'thinking');
    if (thinking === undefined) throw new Error('no thinking option was advertised');
    const value = thinking.options?.[0]?.value;
    if (typeof value !== 'string') throw new Error('the thinking option has no values');
    await agent.request('session/set_config_option', {
      sessionId: created.sessionId,
      configId: 'thinking',
      value,
    });
    const configured = updates(agent)
      .filter((update) => update.sessionUpdate === 'config_option_update')
      .at(-1);
    const applied = (configured?.configOptions ?? []).find((option) => option.id === 'thinking');
    if (applied?.currentValue !== value) throw new Error('the thinking level did not change');
  });
});

test('/tower answers with a status or a notice', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const { response, text } = await runCommand(agent, sessionId, '/tower');
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
    if (!/tower|Command failed|not implemented/i.test(text)) {
      throw new Error(`unexpected answer: ${text.slice(0, 200)}`);
    }
  });
});



test('an invalid MCP server shape is rejected, a failing server is tolerated', async () => {
  await withAgent({ script: [{ kind: 'text', text: 'still works' }] }, async ({ agent, workDir }) => {
    await boot(agent);
    // The ACP schema rejects a server with neither command nor url.
    await expectReject(
      agent.request('session/new', { cwd: workDir, mcpServers: [{ name: 'broken' }] }, 10_000),
      'a malformed MCP server',
    );
    // A well-formed server that cannot start must not fail the session.
    const created = await agent.request('session/new', {
      cwd: workDir,
      mcpServers: [{ name: 'missing', command: '/definitely/not/a/binary', args: [], env: [] }],
    });
    const response = await prompt(agent, created.sessionId, 'hello');
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
    if (!lastText(agent).includes('still works')) throw new Error('the session did not answer');
  });
});

test('logout either signs out or explains why it cannot', async () => {
  const outcome = async (agent, method) => {
    try {
      const result = await agent.request(method, {}, 30_000);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  await withAgent({ script: [] }, async ({ agent }) => {
    await boot(agent);
    const result = await outcome(agent, 'logout');
    if (result.ok) {
      if (result.result === undefined) throw new Error('v1 logout returned nothing');
    } else if (!/logout failed/i.test(result.message) || result.message.includes('-32603')) {
      throw new Error(`v1 logout failed opaquely: ${result.message}`);
    }
  });
  await withAgent({ script: [] }, async ({ agent }) => {
    await boot(agent, { protocolVersion: 2 });
    const result = await outcome(agent, 'auth/logout');
    if (result.ok) {
      if (result.result === undefined) throw new Error('v2 logout returned nothing');
    } else if (!/logout failed/i.test(result.message) || result.message.includes('-32603')) {
      throw new Error(`v2 logout failed opaquely: ${result.message}`);
    }
  });
});

test('v2 session lifecycle, steering and goal', async () => {
  await withAgent(
    { script: [{ kind: 'text', text: 'v2 answer' }, { kind: 'text', text: 'slow' }, { kind: 'text', text: 'after' }], delayMs: 2_000 },
    async ({ agent, workDir }) => {
      await boot(agent, { protocolVersion: 2 });
      const created = await agent.request('session/new', { cwd: workDir });
      const sessionId = created.sessionId;
      const listed = await agent.request('session/list', {});
      if (!(listed.sessions ?? []).some((session) => session.sessionId === sessionId)) {
        throw new Error('v2 session/list missed the session');
      }
      const forked = await agent.request('session/resume', { sessionId, cwd: workDir, mcpServers: [] }, 60_000);
      if (forked === undefined) throw new Error('v2 session/resume returned nothing');

      const running = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'start' }] }, 60_000);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      const injected = await agent.request('_session/steering', {
        sessionId,
        prompt: [{ type: 'text', text: 'also this' }],
      }, 30_000);
      if (injected.outcome !== 'injected') throw new Error(`v2 steering outcome ${injected.outcome}`);
      await running;

      await agent.request('_session/goal', { sessionId, action: 'set', objective: 'v2 objective' });
      await waitFor(
        () => updates(agent).some((update) => String(update.toolCallId ?? '').startsWith('goal:')),
        'the v2 goal card',
      );
      await agent.request('_session/goal', { sessionId, action: 'clear' });

      const fork = await agent.request('session/fork', { sessionId, cwd: workDir, mcpServers: [] }, 60_000);
      if (typeof fork.sessionId !== 'string') throw new Error('v2 fork returned no session');
      await agent.request('session/delete', { sessionId: fork.sessionId }, 30_000);
      await agent.request('session/close', { sessionId: fork.sessionId }, 30_000);
    },
  );
});

// --- transport robustness --------------------------------------------------

test('a malformed JSON-RPC frame is answered and the connection survives', async () => {
  await withAgent({ script: [{ kind: 'text', text: 'alive' }] }, async ({ agent, workDir }) => {
    agent.writeRaw('this is not json');
    await waitFor(() => agent.protocolErrors.length > 0, 'the parse-error response');
    const parseError = agent.protocolErrors[0];
    if (parseError.code !== -32700) throw new Error(`unexpected code ${parseError.code}`);
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const response = await prompt(agent, sessionId, 'hello');
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
    if (!lastText(agent).includes('alive')) throw new Error('the session did not answer after a parse error');
  });
});

// --- plugin commands -------------------------------------------------------


// --- custom API key and session titles -------------------------------------

test('a custom API key from the environment reaches the provider', async () => {
  const provider = await startFakeProvider({ script: [{ kind: 'text', text: 'env key ok' }] });
  const homeDir = writeFakeHome({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'unused' });
  const workDir = mkdtempSync(join(tmpdir(), 'kimi-acp-suite-'));
  const agent = spawnAgent(mainPath, {
    homeDir,
    env: {
      KIMI_MODEL_NAME: 'custom-model',
      KIMI_MODEL_API_KEY: 'sk-custom-key',
      KIMI_MODEL_BASE_URL: provider.baseUrl,
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_MAX_CONTEXT_SIZE: '8192',
    },
  });
  try {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const response = await prompt(agent, sessionId, 'hello with a custom key', 60_000);
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
    if (!lastText(agent).includes('env key ok')) throw new Error('the env-model session did not answer');
    const request = provider.requests[0];
    if (request === undefined) throw new Error('the provider received no request');
    if (request.headers?.authorization !== 'Bearer sk-custom-key') {
      throw new Error(`authorization header: ${JSON.stringify(request.headers?.authorization)}`);
    }
  } finally {
    await agent.close();
    await provider.close();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('session/set_title sets the title and emits session info', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    const init = await boot(agent);
    if (init.agentCapabilities?.sessionCapabilities?.title === undefined) {
      throw new Error('the title capability is not advertised');
    }
    const sessionId = await newSession(agent, workDir);
    const response = await agent.request('session/set_title', { sessionId, title: '  My Title  ' });
    if (response.title !== 'My Title') throw new Error(`returned title ${JSON.stringify(response.title)}`);
    await waitFor(
      () =>
        updates(agent).some(
          (update) =>
            update.sessionUpdate === 'session_info_update' &&
            update.title === 'My Title' &&
            typeof update.updatedAt === 'string',
        ),
      'the session_info_update',
    );
    const listed = await agent.request('session/list', {});
    const entry = listed.sessions.find((session) => session.sessionId === sessionId);
    if (entry?.title !== 'My Title') throw new Error(`session/list title: ${JSON.stringify(entry?.title)}`);
    await expectReject(
      agent.request('session/set_title', { sessionId, title: '   ' }, 5_000),
      'an empty title',
    );
  });
});

// --- auto session titles ---------------------------------------------------

test('a generated title becomes the session_info_update title', async () => {
  await withAgent(
    {
      script: [{ kind: 'text', text: 'the answer' }, { kind: 'text', text: 'Short Generated Title' }],
      autoSessionTitle: true,
    },
    async ({ agent, provider, workDir }) => {
      await boot(agent);
      const sessionId = await newSession(agent, workDir);
      await prompt(agent, sessionId, 'please fix the parser bug');
      await waitFor(
        () =>
          updates(agent).some(
            (update) => update.sessionUpdate === 'session_info_update' && update.title === 'Short Generated Title',
          ),
        'the generated title',
      );
      const listed = await agent.request('session/list', {});
      const entry = listed.sessions.find((session) => session.sessionId === sessionId);
      if (entry?.title !== 'Short Generated Title') {
        throw new Error(`session/list title: ${JSON.stringify(entry?.title)}`);
      }
      const titleRequest = provider.requests.find((request) => {
        try {
          return JSON.parse(request.body)?.stream === false;
        } catch {
          return false;
        }
      });
      if (titleRequest === undefined) throw new Error('no title request reached the provider');
      if (titleRequest.headers?.authorization !== 'Bearer test-token') {
        throw new Error(`title request auth: ${JSON.stringify(titleRequest.headers?.authorization)}`);
      }
      const titleBody = JSON.parse(titleRequest.body);
      if (!String(titleBody.messages?.[1]?.content ?? '').includes('parser bug')) {
        throw new Error('the title prompt does not carry the first user text');
      }
    },
  );
});

test('auto title generation does not call the model when disabled', async () => {
  await withAgent(
    { script: [{ kind: 'text', text: 'the answer' }], autoSessionTitle: false },
    async ({ agent, provider, workDir }) => {
      await boot(agent);
      const sessionId = await newSession(agent, workDir);
      await prompt(agent, sessionId, 'please fix the parser bug');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      if (provider.requests.length !== 1) {
        throw new Error(`expected one model request, got ${provider.requests.length}`);
      }
      // The engine still publishes its own easy title (the first user line);
      // what must not happen is an adapter-side model call for a title.
      const info = updates(agent).filter((update) => update.sessionUpdate === 'session_info_update');
      for (const update of info) {
        if (update.title !== 'please fix the parser bug') {
          throw new Error(`unexpected title: ${JSON.stringify(update.title)}`);
        }
      }
    },
  );
});

test('a failed title request falls back to the first user line', async () => {
  await withAgent(
    { script: [{ kind: 'text', text: 'the answer' }], autoSessionTitle: true },
    async ({ agent, workDir }) => {
      await boot(agent);
      const sessionId = await newSession(agent, workDir);
      await prompt(agent, sessionId, 'please fix the parser bug');
      await waitFor(
        () =>
          updates(agent).some(
            (update) =>
              update.sessionUpdate === 'session_info_update' &&
              update.title === 'please fix the parser bug',
          ),
        'the fallback title',
      );
    },
  );
});


test('dropped commands are neither advertised nor callable', async () => {
  await withAgent({ script: [] }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    await waitFor(
      () => updates(agent).some((update) => update.sessionUpdate === 'available_commands_update'),
      'the command list',
    );
    const advertised = updates(agent)
      .filter((update) => update.sessionUpdate === 'available_commands_update')
      .flatMap((update) => update.availableCommands ?? [])
      .map((command) => command.name);
    for (const hidden of ['add-dir', 'model', 'effort', 'plugins', 'plan', 'yolo', 'auto']) {
      if (advertised.includes(hidden)) throw new Error(`${hidden} is still advertised`);
    }
    for (const name of advertised) {
      if (name.includes(':')) throw new Error(`plugin command advertised: ${name}`);
    }
    const addDir = await runCommand(agent, sessionId, '/add-dir /tmp');
    if (!addDir.text.includes('Added /tmp')) throw new Error(`/add-dir still runs? ${addDir.text.slice(0, 120)}`);
  });
});






test('rewind reaches a skill turn and drops what follows it', async () => {
  const marker = 'SUITE-SKILL-REWIND-MARKER';
  await withAgent(
    {
      script: [
        { kind: 'text', text: 'first answer' },
        { kind: 'text', text: 'skill answer' },
        { kind: 'text', text: 'third answer' },
        { kind: 'text', text: 'fourth answer' },
      ],
      setupHome: (homeDir) => {
        const dir = join(homeDir, 'skills', 'suite-skill');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'SKILL.md'),
          `---\nname: suite-skill\ndescription: A skill the suite invokes.\n---\n\n# Suite skill\n\n${marker}\n`,
        );
      },
    },
    async ({ agent, provider, workDir }) => {
      const capabilities = zedCapabilities();
      capabilities.session.cursors = {};
      await boot(agent, { capabilities });
      const sessionId = await newSession(agent, workDir);
      await prompt(agent, sessionId, 'first question');
      await prompt(agent, sessionId, '/suite-skill do the thing');
      await prompt(agent, sessionId, 'third question');
      const cursors = updates(agent).filter((update) => update.sessionUpdate === 'cursor_update');
      // Live cursors exist for the skill turn and the third prompt (the first
      // prompt has no earlier entity to anchor to).
      if (cursors.length !== 2) throw new Error(`expected two cursors, got ${cursors.length}`);
      const rewound = await agent.request('_session/rewind', { sessionId, cursorId: cursors[0].cursorId });
      if (rewound.rewound !== true) throw new Error(`rewind answered ${JSON.stringify(rewound)}`);
      await prompt(agent, sessionId, 'fourth question');
      const body = provider.requests.at(-1)?.body ?? '';
      if (!body.includes('first question')) throw new Error('the kept turn is missing');
      if (body.includes(marker)) throw new Error('the skill turn survived the rewind');
      if (body.includes('third question')) throw new Error('the third turn survived the rewind');
    },
  );
});


const SUBAGENT_SCRIPT = [
  { kind: 'tool', id: 'agent_1', name: 'Agent', arguments: JSON.stringify({ description: 'probe child', prompt: 'child task' }) },
  { kind: 'text', text: 'child answer' },
  { kind: 'text', text: 'parent done' },
];

test('a subagent never settles the parent turn or speaks as the parent', async () => {
  await withAgent({ script: SUBAGENT_SCRIPT }, async ({ agent, workDir }) => {
    await boot(agent);
    const sessionId = await newSession(agent, workDir);
    const response = await prompt(agent, sessionId, 'spawn a child', 120_000);
    if (response.stopReason !== 'end_turn') throw new Error(`stopReason ${response.stopReason}`);
    const parentText = updates(agent)
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content?.text ?? '')
      .join('');
    if (!parentText.includes('parent done')) throw new Error(`the parent did not finish: ${parentText.slice(0, 120)}`);
    if (parentText.includes('child answer')) throw new Error('the child spoke as the parent');
    if (updates(agent).some((update) => update.sessionUpdate === 'subagent_update')) {
      throw new Error('subagent_update was sent without the capability');
    }
    const card = updates(agent).find(
      (update) => update.sessionUpdate === 'tool_call' && String(update.toolCallId).startsWith('subagent:'),
    );
    if (card === undefined) throw new Error('no subagent card');
  });
});

test('a subagents-capable client gets subagent_update and the child stream', async () => {
  await withAgent({ script: SUBAGENT_SCRIPT }, async ({ agent, workDir }) => {
    const capabilities = zedCapabilities();
    capabilities.subagents = {};
    await boot(agent, { capabilities });
    const sessionId = await newSession(agent, workDir);
    await prompt(agent, sessionId, 'spawn a child', 120_000);
    const announcements = updates(agent).filter((update) => update.sessionUpdate === 'subagent_update');
    if (announcements.length < 3) throw new Error(`expected announce/running/idle, got ${announcements.length}`);
    const childId = announcements[0].sessionId;
    if (!childId.startsWith(`subagent:${sessionId}:`)) throw new Error(`child session id ${childId}`);
    if (announcements[0].title !== 'coder') throw new Error(`title ${JSON.stringify(announcements[0].title)}`);
    const states = announcements.map((update) => update.state?.state);
    if (states.at(-1) !== 'idle') throw new Error(`states ${JSON.stringify(states)}`);
    const childText = agent.notifications
      .filter(
        (message) =>
          message.method === 'session/update' &&
          message.params.sessionId === childId &&
          message.params.update.sessionUpdate === 'agent_message_chunk',
      )
      .map((message) => message.params.update.content?.text ?? '')
      .join('');
    if (!childText.includes('child answer')) throw new Error(`child stream: ${JSON.stringify(childText)}`);
    const parentText = agent.notifications
      .filter(
        (message) =>
          message.method === 'session/update' &&
          message.params.sessionId === sessionId &&
          message.params.update.sessionUpdate === 'agent_message_chunk',
      )
      .map((message) => message.params.update.content?.text ?? '')
      .join('');
    if (parentText.includes('child answer')) throw new Error('the child leaked into the parent stream');
  });
});


test('a long shell command keeps its full text in the card body', async () => {
  const longDir = '/data/project/OrderProductionCollaborationSystem/packages/backend/src';
  const command = `cd ${longDir} && ls -la`;
  await withAgent(
    { script: [{ kind: 'tool', id: 'call_long', name: 'Bash', arguments: JSON.stringify({ command }) }, { kind: 'text', text: 'done' }] },
    async ({ agent, workDir }) => {
      await boot(agent);
      const sessionId = await newSession(agent, workDir);
      await prompt(agent, sessionId, 'list it', 120_000);
      const card = updates(agent).find(
        (update) => update.sessionUpdate === 'tool_call' && update.toolCallId === '0:call_long',
      );
      if (card === undefined) throw new Error('no tool card');
      if (card.title !== command) throw new Error(`title is ${JSON.stringify(card.title)}`);
      const text = (card.content ?? [])
        .filter((entry) => entry.type === 'content')
        .map((entry) => entry.content?.text ?? '')
        .join('');
      if (!text.includes(command)) throw new Error(`the card body lost the command: ${JSON.stringify(text)}`);
      if (!text.includes('ls -la')) throw new Error('the card body is truncated');
    },
  );
});


test('AIR session index: batch_get, subscribe and change notifications', async () => {
  await withAgent(
    { script: [{ kind: 'text', text: 'hi' }] },
    async ({ agent, workDir }) => {
      const capabilities = airCapabilities(['sessionIndex', 'sessionBatchGet', 'sessionRename', 'sessionListSubscribe']);
      const init = await boot(agent, { capabilities });
      const advertised = init._meta?.jetbrains?.air?.capabilities ?? [];
      for (const capability of ['sessionIndex', 'sessionBatchGet', 'sessionListSubscribe']) {
        if (!advertised.includes(capability)) throw new Error(`capability ${capability} not advertised`);
      }

      const { subscriptionId } = await agent.request('_session/list/subscribe', { cwd: workDir });
      if (typeof subscriptionId !== 'string') throw new Error('no subscriptionId');
      const changes = () =>
        agent.notifications
          .filter((message) => message.method === '_session/list/changes')
          .map((message) => message.params);

      const sessionId = await newSession(agent, workDir);
      await waitFor(
        () => changes().some((change) => change.subscriptionId === subscriptionId && change.sessions.some((row) => row.sessionId === sessionId)),
        'the created-session change',
      );

      const got = await agent.request('_session/batch_get', { sessionIds: [sessionId] });
      if (got.sessions[0]?.sessionId !== sessionId) throw new Error(`batch_get: ${JSON.stringify(got)}`);
      if (got.sessions[0].cwd !== workDir) throw new Error(`batch_get cwd: ${got.sessions[0].cwd}`);
      await expectReject(agent.request('_session/batch_get', { sessionIds: ['session_missing'] }), 'an unknown id');

      await agent.request('_session/rename', { sessionId, title: 'Indexed' });
      await waitFor(
        () => changes().some((change) => change.sessions.some((row) => row.sessionId === sessionId && row.title === 'Indexed')),
        'the rename change',
      );

      await agent.request('session/delete', { sessionId });
      await waitFor(
        () => changes().some((change) => (change.removed ?? []).includes(sessionId)),
        'the removal change',
      );

      const before = changes().length;
      await agent.request('_session/list/unsubscribe', { subscriptionId });
      const other = await newSession(agent, workDir);
      await prompt(agent, other, 'hi');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
      if (changes().length !== before) throw new Error('changes kept arriving after unsubscribe');
    },
  );
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