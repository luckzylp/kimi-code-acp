import { describe, expect, it } from 'vitest';

import { stateUpdate, toV2Updates } from '../src/v2-updates';

const SESSION = 'session_test';

function note(update: Record<string, unknown>): { sessionId: string; update: Record<string, unknown> } {
  return { sessionId: SESSION, update };
}

describe('toV2Updates', () => {
  it('passes message chunks through with a messageId', () => {
    const [chunk] = toV2Updates(
      note({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hi' } }) as never,
    );
    expect(chunk).toMatchObject({ sessionUpdate: 'agent_message_chunk', messageId: 'm1' });
    const [anonymous] = toV2Updates(
      note({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } }) as never,
    );
    expect(typeof anonymous?.messageId).toBe('string');
  });

  it('turns a tool card into tool_call_update plus terminal_update', () => {
    const updates = toV2Updates(
      note({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Running: echo hi',
        kind: 'execute',
        status: 'pending',
        _meta: { terminal_info: { terminal_id: 't1', cwd: '/tmp/x' } },
      }) as never,
    );
    expect(updates[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      name: 'Running: echo hi',
      kind: 'execute',
    });
    expect(updates[1]).toMatchObject({
      sessionUpdate: 'terminal_update',
      terminalId: 't1',
      cwd: '/tmp/x',
    });
  });

  it('turns terminal output and exit meta into v2 terminal updates', () => {
    const updates = toV2Updates(
      note({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'in_progress',
        _meta: { terminal_output: { terminal_id: 't1', data: 'hello\n' } },
      }) as never,
    );
    expect(updates).toContainEqual({
      sessionUpdate: 'terminal_output_chunk',
      terminalId: 't1',
      data: 'hello\n',
    });

    const exited = toV2Updates(
      note({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        _meta: { terminal_exit: { terminal_id: 't1', exit_code: 2, signal: null } },
      }) as never,
    );
    expect(exited).toContainEqual({
      sessionUpdate: 'terminal_update',
      terminalId: 't1',
      exitStatus: { exitCode: 2, signal: null },
    });
  });

  it('turns a plan into plan_update items', () => {
    const [plan] = toV2Updates(
      note({
        sessionUpdate: 'plan',
        entries: [{ content: 'step', priority: 'medium', status: 'pending' }],
      }) as never,
    );
    expect(plan).toMatchObject({
      sessionUpdate: 'plan_update',
      plan: { type: 'items', entries: [{ content: 'step' }] },
    });
  });

  it('keeps command, info and usage updates', () => {
    for (const kind of ['available_commands_update', 'session_info_update', 'usage_update']) {
      const [kept] = toV2Updates(note({ sessionUpdate: kind, value: 1 }) as never);
      expect(kept).toMatchObject({ sessionUpdate: kind, value: 1 });
    }
  });

  it('renames config option ids to configId for v2', () => {
    const [kept] = toV2Updates(
      note({
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
      }) as never,
    );
    expect(kept).toMatchObject({
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          type: 'select',
          configId: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'fake',
          options: [{ value: 'fake', name: 'fake' }],
        },
      ],
    });
  });

  it('drops update kinds v2 has no equivalent for', () => {
    expect(toV2Updates(note({ sessionUpdate: 'goal_progress' }) as never)).toEqual([]);
  });
});

describe('stateUpdate', () => {
  it('builds the foreground state envelope', () => {
    expect(stateUpdate('running')).toEqual({ sessionUpdate: 'state_update', state: 'running' });
    expect(stateUpdate('idle')).toEqual({ sessionUpdate: 'state_update', state: 'idle' });
  });
});