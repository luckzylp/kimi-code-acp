import { describe, expect, it } from 'vitest';

import { initializeResponse } from '../src/v2';
import { stateUpdate, toV2ConfigOptions, toV2Updates } from '../src/v2-updates';

type Schema = { safeParse: (value: unknown) => { success: boolean; error?: { issues: unknown } } };

const zod = (await import(
  new URL(
    '../node_modules/@agentclientprotocol/sdk-v1/dist/v2/schema/zod.gen.js',
    import.meta.url,
  ).href
)) as Record<string, Schema>;

function expectValid(schema: Schema, value: unknown, label: string): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label} is invalid: ${JSON.stringify(parsed.error?.issues).slice(0, 800)}`);
  }
}

const SESSION = 'session_test';

function note(update: Record<string, unknown>): { sessionId: string; update: Record<string, unknown> } {
  return { sessionId: SESSION, update };
}

const v1ConfigOption = {
  type: 'select',
  id: 'model',
  name: 'Model',
  category: 'model',
  currentValue: 'fake',
  options: [{ value: 'fake', name: 'fake', description: 'the fake model' }],
};

const v1Notifications: Record<string, unknown>[] = [
  { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'hello' } },
  { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'hi' } },
  { sessionUpdate: 'agent_thought_chunk', messageId: 't1', content: { type: 'text', text: 'hm' } },
  {
    sessionUpdate: 'tool_call',
    toolCallId: '0:1',
    title: 'Running: echo hi',
    kind: 'execute',
    status: 'pending',
    content: [
      { type: 'content', content: { type: 'text', text: '{"command":"echo hi"}' } },
      { type: 'diff', path: '/tmp/a.ts', oldText: 'a', newText: 'b' },
      { type: 'terminal', terminalId: '0:1' },
    ],
    locations: [{ path: '/tmp/a.ts', line: 1 }],
    rawInput: { command: 'echo hi' },
    _meta: { terminal_info: { terminal_id: '0:1', cwd: '/tmp' } },
  },
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: '0:1',
    status: 'in_progress',
    _meta: { terminal_output: { terminal_id: '0:1', data: 'hi\n' } },
  },
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: '0:1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'hi\n' } }],
    rawOutput: 'hi\n',
    _meta: { terminal_exit: { terminal_id: '0:1', exit_code: 0, signal: null } },
  },
  {
    sessionUpdate: 'plan',
    entries: [
      { content: 'step one', priority: 'medium', status: 'completed' },
      { content: 'step two', priority: 'medium', status: 'in_progress' },
    ],
  },
  {
    sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: 'goal', description: 'Goal', input: { hint: '<objective>' } }],
  },
  { sessionUpdate: 'config_option_update', configOptions: [v1ConfigOption] },
  { sessionUpdate: 'session_info_update', title: 'A title' },
  { sessionUpdate: 'usage_update', used: 1200, size: 200000 },
];

describe('v2 wire contract', () => {
  it('initialize response matches the v2 schema', () => {
    expectValid(zod['zInitializeResponse'], initializeResponse(), 'initialize');
  });

  it('new session and prompt responses match the v2 schema', () => {
    expectValid(
      zod['zNewSessionResponse'],
      {
        sessionId: SESSION,
        configOptions: toV2ConfigOptions([v1ConfigOption]),
      },
      'session/new',
    );
    expectValid(zod['zSetSessionConfigOptionResponse'], {
      configOptions: toV2ConfigOptions([v1ConfigOption]),
    }, 'set_config_option');
    expectValid(zod['zPromptResponse'], {}, 'prompt');
  });

  it('providers/list response matches the v2 schema', () => {
    expectValid(
      zod['zListProvidersResponse'],
      {
        providers: [
          {
            providerId: 'smitai',
            supported: ['openai'],
            required: false,
            current: { apiType: 'openai', baseUrl: 'https://api.example.test/v1' },
          },
        ],
      },
      'providers/list',
    );
  });

  it('every config option matches the v2 schema', () => {
    for (const option of toV2ConfigOptions([v1ConfigOption])) {
      expectValid(zod['zSessionConfigOption'], option, 'config option');
    }
  });

  it('every translated session update matches the v2 schema', () => {
    for (const notification of v1Notifications) {
      const translated = toV2Updates(note(notification) as never);
      expect(translated.length).toBeGreaterThan(0);
      for (const update of translated) {
        expectValid(zod['zSessionUpdate'], update, String(notification['sessionUpdate']));
      }
    }
  });

  it('state updates match the v2 schema', () => {
    for (const value of ['running', 'idle', 'requires_action'] as const) {
      expectValid(zod['zSessionUpdate'], stateUpdate(value), `state ${value}`);
    }
  });
});