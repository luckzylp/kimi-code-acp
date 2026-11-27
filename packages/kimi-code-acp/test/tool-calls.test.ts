import { describe, expect, it } from 'vitest';

import { ToolCalls, resultContent } from '../src/tool-calls';

describe('resultContent', () => {
  it('fences a command result so it reads as code, like the command does', () => {
    const [content] = resultContent('src/a.ts\nsrc/b.ts', { codeBlock: true });
    expect(content).toEqual({
      type: 'content',
      content: { type: 'text', text: '```\nsrc/a.ts\nsrc/b.ts\n```' },
    });
  });

  it('widens the fence past a backtick run in the output', () => {
    const [content] = resultContent('echo ``` inside', { codeBlock: true });
    expect(content).toEqual({
      type: 'content',
      content: { type: 'text', text: '````\necho ``` inside\n````' },
    });
  });

  it('keeps a non-command result as prose', () => {
    const [content] = resultContent('plain text');
    expect(content).toEqual({ type: 'content', content: { type: 'text', text: 'plain text' } });
  });
});

describe('settleTurn', () => {
  it('closes a call whose turn ended without a result', () => {
    const emitted: unknown[] = [];
    const calls = new ToolCalls({
      sessionId: 'session_test',
      cwd: () => '/tmp',
      shadowTerminals: false,
      emit: (notification) => emitted.push(notification),
    });
    calls.started({
      turnId: 7,
      toolCallId: 'call_1',
      name: 'Bash',
      args: { command: 'sleep 1000' },
      description: 'Running: sleep 1000',
      display: { kind: 'command', command: 'sleep 1000', cwd: '/tmp' },
    } as never);
    calls.settleTurn(7, 'failed');
    const update = emitted.at(-1) as { update: { sessionUpdate: string; toolCallId: string; status: string } };
    expect(update.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: '7:call_1',
      status: 'failed',
    });
    calls.settleTurn(7, 'failed');
    expect(emitted).toHaveLength(2);
  });

  it('keeps the command in an execute title', () => {
    const emitted: Array<{ update: { title?: string; content?: unknown[] } }> = [];
    const calls = new ToolCalls({
      sessionId: 'session_test',
      cwd: () => '/tmp',
      shadowTerminals: false,
      emit: (notification) => emitted.push(notification as never),
    });
    calls.started({
      turnId: 1,
      toolCallId: 'call_2',
      name: 'Bash',
      args: { command: 'cd /data/project/VeryLongDirectoryName && ls -la' },
      description: 'Running: cd /data/project/VeryLongDirectoryName && ls -la',
      display: {
        kind: 'command',
        command: 'cd /data/project/VeryLongDirectoryName && ls -la',
        cwd: '/tmp',
      },
    } as never);
    const card = emitted[0] as { update: { title: string; content: Array<{ content?: { text?: string } }> } };
    expect(card.update.title).toBe('cd /data/project/VeryLongDirectoryName && ls -la');
    expect(JSON.stringify(card.update.content)).toContain('ls -la');
  });
});
