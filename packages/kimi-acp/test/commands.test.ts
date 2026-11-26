import { describe, expect, it } from 'vitest';

import {
  availableBuiltinCommands,
  expandPluginBody,
  parseSlashCommand,
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
      'add-dir',
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
