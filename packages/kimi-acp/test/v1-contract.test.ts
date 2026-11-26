import { describe, expect, it } from 'vitest';

import { goalCard, notice, planNotification, subagentCard, subagentUpdate } from '../src/activity';
import { initializeResponse } from '../src/agent';

type Schema = { safeParse: (value: unknown) => { success: boolean; error?: { issues: unknown } } };

const zod = (await import(
  new URL(
    '../node_modules/@agentclientprotocol/sdk/dist/v1/unstable/schema/zod.gen.js',
    import.meta.url,
  ).href
)) as Record<string, Schema>;

const SESSION = 'session_test';

function expectValid(schema: Schema, value: unknown, label: string): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label} is invalid: ${JSON.stringify(parsed.error?.issues).slice(0, 800)}`);
  }
}

const updates: Array<[string, Record<string, unknown>]> = [
  ['user_message_chunk', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } }],
  ['agent_message_chunk', { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'hi' } }],
  ['agent_thought_chunk', { sessionUpdate: 'agent_thought_chunk', messageId: 't1', content: { type: 'text', text: 'hm' } }],
  [
    'tool_call',
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
  ],
  [
    'tool_call_update',
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: '0:1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'hi\n' } }],
      rawOutput: 'hi\n',
      _meta: { terminal_exit: { terminal_id: '0:1', exit_code: 0, signal: null } },
    },
  ],
  ['plan', { sessionUpdate: 'plan', entries: [{ content: 'step', priority: 'medium', status: 'pending' }] }],
  [
    'available_commands_update',
    {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'goal', description: 'Goal', input: { hint: '<objective>' } }],
    },
  ],
  [
    'config_option_update',
    {
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          type: 'select',
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'fake',
          options: [{ value: 'fake', name: 'fake' }],
        },
      ],
    },
  ],
  ['session_info_update', { sessionUpdate: 'session_info_update', title: 'A title' }],
  ['usage_update', { sessionUpdate: 'usage_update', used: 10, size: 100 }],
  [
    'prompt_suggestions_update',
    {
      sessionUpdate: 'prompt_suggestions_update',
      suggestions: [{ prompt: [{ type: 'text', text: 'run the tests' }] }],
    },
  ],
];

describe('v1 wire contract', () => {
  it('initialize response matches the v1 schema', () => {
    expectValid(zod['zInitializeResponse'], initializeResponse(), 'initialize');
  });

  it('providers/list response matches the v1 schema', () => {
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

  it('every projected session update matches the v1 schema', () => {
    for (const [label, update] of updates) {
      expectValid(zod['zSessionUpdate'], update, label);
    }
  });

  it('activity projections match the v1 schema', () => {
    const projected = [
      planNotification(SESSION, [
        { title: 'one', status: 'done' },
        { title: 'two', status: 'in_progress' },
        { title: 'three', status: 'pending' },
      ]),
      goalCard(SESSION, {
        goalId: 'g1',
        objective: 'ship it',
        status: 'active',
        turnsUsed: 2,
        tokensUsed: 100,
        wallClockMs: 1000,
        budget: { remainingTurns: 8, remainingTokens: 1000, remainingWallClockMs: null, overBudget: false },
      }),
      subagentCard(SESSION, { subagentId: 's1', subagentName: 'reviewer', description: 'review', swarmIndex: 0 }),
      subagentUpdate(SESSION, 's1', 'completed', 'done'),
      notice(SESSION, 'compaction complete'),
    ];
    for (const notification of projected) {
      if (notification === null) throw new Error('projection was empty');
      expectValid(zod['zSessionUpdate'], notification.update, String(notification.update.sessionUpdate));
    }
  });
});