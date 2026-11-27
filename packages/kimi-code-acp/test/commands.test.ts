import { describe, expect, it } from 'vitest';

import {
  availableBuiltinCommands,
  expandPluginBody,
  parseSlashCommand,
  pluginSlashCommands,
  runBuiltinCommand,
} from '../src/commands';

describe('parseSlashCommand', () => {
  it('parses a name and its arguments', () => {
    expect(parseSlashCommand('/goal create ship it')).toEqual({ name: 'goal', args: 'create ship it' });
    expect(parseSlashCommand('/status')).toEqual({ name: 'status', args: '' });
    expect(parseSlashCommand('  /swarm on  ')).toEqual({ name: 'swarm', args: 'on' });
  });

  it('allows plugin command names with a colon', () => {
    expect(parseSlashCommand('/my-plugin:review the diff')).toEqual({
      name: 'my-plugin:review',
      args: 'the diff',
    });
  });

  it('leaves plain text and bare slashes alone', () => {
    expect(parseSlashCommand('hello /goal')).toBeNull();
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });
});

describe('advertised commands', () => {
  it('covers the TUI features the adapter wires', () => {
    const names = availableBuiltinCommands().map((command) => command.name);
    for (const expected of [
      'goal',
      'swarm',
      'compact',
      'status',
      'usage',
      'permission',
      'model',
      'effort',
      'title',
      'undo',
      'tasks',
      'mcp',
      'plugins',
      'init',
      'help',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('advertises argument hints where a command takes one', () => {
    const goal = availableBuiltinCommands().find((command) => command.name === 'goal');
    expect(goal?.input?.hint).toContain('objective');
  });
});

describe('expandPluginBody', () => {
  it('substitutes $ARGUMENTS when present', () => {
    expect(expandPluginBody('Review $ARGUMENTS carefully', 'the diff')).toBe(
      'Review the diff carefully',
    );
  });

  it('appends arguments otherwise', () => {
    expect(expandPluginBody('Review the code', 'src/app.ts')).toBe('Review the code\n\nsrc/app.ts');
    expect(expandPluginBody('Review the code', '')).toBe('Review the code');
  });
});


describe('pluginSlashCommands', () => {
  it('advertises plugin commands as pluginId:name with their bodies', async () => {
    const session = {
      listPluginCommands: async () => [
        { pluginId: 'my-plugin', name: 'review', description: 'Review it', body: 'BODY $ARGUMENTS', path: '/p/review.md' },
      ],
    } as never;
    const { advertised, bodies } = await pluginSlashCommands(session);
    expect(advertised).toEqual([{ name: 'my-plugin:review', description: 'Review it' }]);
    expect(bodies.get('my-plugin:review')).toBe('BODY $ARGUMENTS');
  });

  it('degrades to no commands when discovery fails', async () => {
    const session = {
      listPluginCommands: async () => {
        throw new Error('unavailable');
      },
    } as never;
    const { advertised, bodies } = await pluginSlashCommands(session);
    expect(advertised).toEqual([]);
    expect(bodies.size).toBe(0);
  });
});


describe('hidden commands', () => {
  it('does not advertise add-dir but still runs it', async () => {
    expect(availableBuiltinCommands().map((command) => command.name)).not.toContain('add-dir');
    const runtime = {
      sessionId: 's',
      session: { addAdditionalDir: async () => undefined },
      harness: {},
    } as never;
    await expect(runBuiltinCommand('add-dir', '', runtime)).resolves.toEqual({
      text: 'Usage: /add-dir <path>',
    });
  });
});
