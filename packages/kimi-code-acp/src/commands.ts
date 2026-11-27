/**
 * Slash commands (ADR 0001; TUI parity).
 *
 * The kimi TUI exposes ~40 slash commands that drive agent features ACP has no
 * request for: goals, swarm mode, compaction, undo, session titles, extra
 * directories, background tasks, MCP and plugins. ACP clients only understand
 * `available_commands_update`, so this module maps the useful subset onto the
 * same engine primitives the TUI calls, and the adapter advertises them next to
 * skills and plugin commands.
 *
 * A command answers with text in the transcript, or with a prompt to submit
 * (`/swarm <task>` turns swarm mode on and then submits the task).
 */
import type { AvailableCommand } from '@agentclientprotocol/sdk/unstable';
import type { KimiHarness, Session as KimiSession } from '@moonshot-ai/kimi-code-sdk';

import { modelEntries, type AcpModeId } from './config-options';

export interface CommandRuntime {
  readonly sessionId: string;
  readonly session: KimiSession;
  readonly harness: KimiHarness;
  /** Present when the adapter can switch permission/plan modes. */
  setMode?(mode: AcpModeId): Promise<void>;
}

export interface CommandReply {
  /** Words for the transcript; the command starts no model turn. */
  readonly text?: string;
  /** A prompt the adapter should submit as a normal turn. */
  readonly prompt?: string;
}

interface SlashCommandSpec {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  /** Available when typed, but not advertised in `available_commands_update`. */
  readonly hidden?: boolean;
  readonly run: (runtime: CommandRuntime, args: string) => Promise<CommandReply>;
}

const HELP: SlashCommandSpec = {
  name: 'help',
  description: 'List the commands this session understands',
  run: async () => ({
    text: BUILTIN_COMMANDS.filter((spec) => spec.hidden !== true).map(
      (spec) => `/${spec.name}${spec.argumentHint === undefined ? '' : ` ${spec.argumentHint}`} — ${spec.description}`,
    ).join('\n'),
  }),
};

const STATUS: SlashCommandSpec = {
  name: 'status',
  description: 'Show the model, mode and context status of this session',
  run: async (runtime) => {
    const status = await runtime.session.getStatus();
    const percent = status.maxContextTokens > 0
      ? Math.round((status.contextTokens / status.maxContextTokens) * 100)
      : 0;
    return {
      text: [
        `Model: ${status.model ?? '(default)'}`,
        `Thinking: ${status.thinkingEffort}`,
        `Permission: ${status.permission}`,
        `Plan mode: ${status.planMode ? 'on' : 'off'}`,
        `Swarm mode: ${status.swarmMode === true ? 'on' : 'off'}`,
        `Context: ${status.contextTokens.toLocaleString('en-US')} / ${status.maxContextTokens.toLocaleString('en-US')} tokens (${String(percent)}%)`,
      ].join('\n'),
    };
  },
};

const USAGE: SlashCommandSpec = {
  name: 'usage',
  description: 'Show token usage for this session',
  run: async (runtime) => {
    const usage = await runtime.session.getUsage();
    const total = usage.total;
    if (total === undefined) return { text: 'No usage recorded yet.' };
    const cache = total.inputCacheRead ?? 0;
    return {
      text: [
        `Input: ${total.inputOther.toLocaleString('en-US')} tokens`,
        `Output: ${total.output.toLocaleString('en-US')} tokens`,
        ...(cache > 0 ? [`Cache read: ${cache.toLocaleString('en-US')} tokens`] : []),
        ...(total.inputCacheCreation > 0
          ? [`Cache write: ${total.inputCacheCreation.toLocaleString('en-US')} tokens`]
          : []),
      ].join('\n'),
    };
  },
};

const GOAL: SlashCommandSpec = {
  name: 'goal',
  description: 'Start or manage the long-running goal',
  argumentHint: '[status|pause|resume|cancel|replace] [objective]',
  run: async (runtime, args) => {
    const [verb, ...rest] = args.split(/\s+/).filter((token) => token.length > 0);
    const objective = rest.join(' ').trim();
    switch (verb) {
      case undefined:
      case 'status': {
        const { goal } = await runtime.session.getGoal();
        return { text: goal === null ? 'No goal for this session.' : renderGoal(goal) };
      }
      case 'pause':
        return { text: renderGoal(await runtime.session.pauseGoal()) };
      case 'resume':
        return { text: renderGoal(await runtime.session.resumeGoal()) };
      case 'cancel':
        return { text: renderGoal(await runtime.session.cancelGoal()) };
      case 'replace': {
        if (objective.length === 0) return { text: 'Usage: /goal replace <objective>' };
        return { text: renderGoal(await runtime.session.createGoal({ objective, replace: true })) };
      }
      default: {
        const text = args.trim();
        if (text.length === 0) return { text: 'Usage: /goal <objective>' };
        return { text: renderGoal(await runtime.session.createGoal({ objective: text })) };
      }
    }
  },
};

const SWARM: SlashCommandSpec = {
  name: 'swarm',
  description: 'Toggle swarm mode or run one task with it',
  argumentHint: '[on|off] | <task>',
  run: async (runtime, args) => {
    const command = args.trim().toLowerCase();
    if (command === 'on' || command === 'off') {
      await runtime.session.setSwarmMode(command === 'on', 'manual');
      return { text: `Swarm mode ${command}.` };
    }
    if (command.length === 0) {
      const status = await runtime.session.getStatus();
      const next = status.swarmMode !== true;
      await runtime.session.setSwarmMode(next, 'manual');
      return { text: `Swarm mode ${next ? 'on' : 'off'}.` };
    }
    await runtime.session.setSwarmMode(true, 'manual');
    return {
      text: 'Swarm mode on. Submitting the task.',
      prompt: args.trim(),
    };
  },
};

const TOWER: SlashCommandSpec = {
  name: 'tower',
  description: 'Report or toggle tower mode',
  argumentHint: '[status|on|off]',
  run: async (runtime, args) => {
    const command = args.trim().toLowerCase();
    if (command === 'on' || command === 'off') {
      await runtime.session.setTowerMode(command === 'on');
      return { text: `Tower mode ${command}.` };
    }
    return { text: await runtime.session.getTowerStatus() };
  },
};

const COMPACT: SlashCommandSpec = {
  name: 'compact',
  description: 'Compact the conversation context',
  argumentHint: '[instruction]',
  run: async (runtime, args) => {
    const instruction = args.trim();
    await runtime.session.compact(instruction.length === 0 ? {} : { instruction });
    return { text: 'Compaction requested.' };
  },
};

const INIT: SlashCommandSpec = {
  name: 'init',
  description: 'Create or refresh AGENTS.md for this workspace',
  run: async (runtime) => {
    await runtime.session.init();
    return { text: 'AGENTS.md generation requested.' };
  },
};

const UNDO: SlashCommandSpec = {
  name: 'undo',
  description: 'Undo the last N conversation turns',
  argumentHint: '[count]',
  run: async (runtime, args) => {
    const count = Number.parseInt(args.trim(), 10);
    const resolved = Number.isFinite(count) && count > 0 ? count : 1;
    await runtime.session.undoHistory(resolved);
    return { text: `Undid ${String(resolved)} turn(s).` };
  },
};

const TITLE: SlashCommandSpec = {
  name: 'title',
  description: 'Rename this session',
  argumentHint: '<title>',
  run: async (runtime, args) => {
    const title = args.trim();
    if (title.length === 0) return { text: 'Usage: /title <title>' };
    await runtime.harness.renameSession({ id: runtime.sessionId, title });
    return { text: `Renamed to "${title}".` };
  },
};

const ADD_DIR: SlashCommandSpec = {
  name: 'add-dir',
  description: 'Add a directory to this session',
  argumentHint: '<path>',
  // Kept callable, but the client's command palette should not offer it.
  hidden: true,
  run: async (runtime, args) => {
    const path = args.trim();
    if (path.length === 0) return { text: 'Usage: /add-dir <path>' };
    await runtime.session.addAdditionalDir(path);
    return { text: `Added ${path}.` };
  },
};

const TASKS: SlashCommandSpec = {
  name: 'tasks',
  description: 'List background tasks',
  run: async (runtime) => {
    const tasks = await runtime.session.listBackgroundTasks({ limit: 20 });
    if (tasks.length === 0) return { text: 'No background tasks.' };
    return {
      text: tasks
        .map((task) => {
          const record = task as unknown as Record<string, unknown>;
          const id = typeof record['taskId'] === 'string' ? record['taskId'] : '?';
          const status = typeof record['status'] === 'string' ? record['status'] : '?';
          const label =
            typeof record['description'] === 'string'
              ? record['description']
              : typeof record['command'] === 'string'
                ? record['command']
                : typeof record['kind'] === 'string'
                  ? record['kind']
                  : '';
          return `${id} [${status}]${label.length === 0 ? '' : ` — ${label}`}`;
        })
        .join('\n'),
    };
  },
};

const MCP: SlashCommandSpec = {
  name: 'mcp',
  description: 'List this workspace\'s MCP servers',
  run: async (runtime) => {
    const servers = await runtime.session.listMcpServers();
    if (servers.length === 0) return { text: 'No MCP servers configured.' };
    return {
      text: servers
        .map(
          (server) =>
            `${server.name} [${server.status}] ${server.transport} · ${String(server.toolCount)} tool(s)` +
            (server.error === undefined ? '' : `\nerror: ${server.error}`),
        )
        .join('\n'),
    };
  },
};

const PLUGINS: SlashCommandSpec = {
  name: 'plugins',
  description: 'List installed plugins',
  run: async (runtime) => {
    const plugins = await runtime.session.listPlugins();
    const list = (plugins as unknown as readonly unknown[]).map((plugin) => {
      const record = plugin as Record<string, unknown>;
      const name = typeof record['name'] === 'string' ? record['name'] : 'plugin';
      const state = typeof record['state'] === 'string' ? record['state'] : '';
      return `${name}${state.length === 0 ? '' : ` [${state}]`}`;
    });
    return { text: list.length === 0 ? 'No plugins installed.' : list.join('\n') };
  },
};

const MODEL: SlashCommandSpec = {
  name: 'model',
  description: 'Switch the model',
  argumentHint: '[alias]',
  run: async (runtime, args) => {
    const requested = args.trim();
    const models = modelEntries(await runtime.harness.getConfig());
    if (requested.length === 0) {
      return {
        text: models.length === 0
          ? 'No models configured.'
          : `Models: ${models.map((model) => model.id).join(', ')}`,
      };
    }
    await runtime.session.setModel(requested);
    return { text: `Model set to ${requested}.` };
  },
};

const EFFORT: SlashCommandSpec = {
  name: 'effort',
  description: 'Set the thinking effort',
  argumentHint: '<off|low|medium|high>',
  run: async (runtime, args) => {
    const level = args.trim();
    if (level.length === 0) {
      const status = await runtime.session.getStatus();
      return { text: `Thinking effort: ${status.thinkingEffort}` };
    }
    await runtime.session.setThinking(level as never);
    return { text: `Thinking effort set to ${level}.` };
  },
};

const PERMISSION: SlashCommandSpec = {
  name: 'permission',
  description: 'Switch permission mode (default, plan, auto, yolo)',
  argumentHint: '[mode]',
  run: async (runtime, args) => {
    const mode = args.trim().toLowerCase();
    if (mode.length === 0) {
      const status = await runtime.session.getStatus();
      return { text: `Permission: ${status.permission}${status.planMode ? ' (plan mode)' : ''}` };
    }
    if (mode !== 'default' && mode !== 'plan' && mode !== 'auto' && mode !== 'yolo') {
      return { text: 'Usage: /permission [default|plan|auto|yolo]' };
    }
    return switchMode(runtime, mode);
  },
};

/** Apply an ACP mode and describe it; the runtime emits the mode/config updates. */
async function switchMode(runtime: CommandRuntime, mode: 'default' | 'plan' | 'auto' | 'yolo'): Promise<CommandReply> {
  if (runtime.setMode === undefined) return { text: 'Mode switching is unavailable.' };
  await runtime.setMode(mode);
  return { text: `Mode set to ${mode}.` };
}

const PLAN: SlashCommandSpec = {
  name: 'plan',
  description: 'Toggle plan mode, or turn it on/off',
  argumentHint: '[on|off]',
  run: async (runtime, args) => {
    const arg = args.trim().toLowerCase();
    if (arg === 'clear') return { text: 'Plan mode has no plan file here; /plan toggles the mode.' };
    if (arg.length > 0 && arg !== 'on' && arg !== 'off') {
      return { text: 'Usage: /plan [on|off]' };
    }
    const status = await runtime.session.getStatus();
    const on = arg.length === 0 ? !status.planMode : arg === 'on';
    // Leaving plan mode restores manual approvals rather than the previous
    // permission mode: the engine reports no previous mode to restore.
    return switchMode(runtime, on ? 'plan' : 'default');
  },
};

const YOLO: SlashCommandSpec = {
  name: 'yolo',
  description: 'Ask When Needed mode: routine edits and commands run automatically; risky actions still ask',
  run: async (runtime) => switchMode(runtime, 'yolo'),
};

const AUTO: SlashCommandSpec = {
  name: 'auto',
  description: 'Never Ask mode: everything runs and is decided automatically',
  run: async (runtime) => switchMode(runtime, 'auto'),
};

const LOGOUT: SlashCommandSpec = {
  name: 'logout',
  description: 'Sign out of the Kimi account',
  run: async (runtime) => {
    await runtime.harness.auth.logout();
    return { text: 'Signed out.' };
  },
};

export const BUILTIN_COMMANDS: readonly SlashCommandSpec[] = [
  HELP,
  STATUS,
  USAGE,
  GOAL,
  SWARM,
  TOWER,
  PLAN,
  YOLO,
  AUTO,
  COMPACT,
  INIT,
  UNDO,
  TITLE,
  ADD_DIR,
  TASKS,
  MCP,
  PLUGINS,
  MODEL,
  EFFORT,
  PERMISSION,
  LOGOUT,
];

/** The commands advertised to the client, in the ACP advertisement shape. */
export function availableBuiltinCommands(): AvailableCommand[] {
  return BUILTIN_COMMANDS.filter((spec) => spec.hidden !== true).map((spec) => ({
    name: spec.name,
    description: spec.description,
    ...(spec.argumentHint === undefined ? {} : { input: { hint: spec.argumentHint } }),
  }));
}

/** Parse `/name args`; null for plain text or for a bare `/`. */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([A-Za-z0-9._:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (match === null) return null;
  const name = match[1];
  if (name === undefined) return null;
  return { name, args: match[2]?.trim() ?? '' };
}

/** Run a built-in command, or null when the name is not one. */
export async function runBuiltinCommand(
  name: string,
  args: string,
  runtime: CommandRuntime,
): Promise<CommandReply | null> {
  const spec = BUILTIN_COMMANDS.find((candidate) => candidate.name === name.toLowerCase());
  if (spec === undefined) return null;
  return spec.run(runtime, args);
}

function renderGoal(goal: {
  readonly objective: string;
  readonly status: string;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly completionCriterion?: string;
  readonly terminalReason?: string;
}): string {
  return [
    `Goal: ${goal.objective.split('\n')[0] ?? ''}`,
    `Status: ${goal.status}`,
    `Turns: ${String(goal.turnsUsed)} · Tokens: ${goal.tokensUsed.toLocaleString('en-US')}`,
    ...(goal.completionCriterion === undefined ? [] : [`Done when: ${goal.completionCriterion}`]),
    ...(goal.terminalReason === undefined ? [] : [`Reason: ${goal.terminalReason}`]),
  ].join('\n');
}

/** Plugin commands as `pluginId:name` with their body as the prompt template. */
export async function pluginSlashCommands(
  session: KimiSession,
): Promise<{ advertised: AvailableCommand[]; bodies: Map<string, string> }> {
  const advertised: AvailableCommand[] = [];
  const bodies = new Map<string, string>();
  try {
    const defs = await session.listPluginCommands();
    for (const def of defs) {
      const name = `${def.pluginId}:${def.name}`;
      advertised.push({ name, description: def.description });
      bodies.set(name, def.body);
    }
  } catch {
    // Plugin discovery may be unavailable; commands are simply not offered.
  }
  return { advertised, bodies };
}

/** Expand a plugin command body the way the TUI does: body, then the arguments. */
export function expandPluginBody(body: string, args: string): string {
  if (args.length === 0) return body;
  if (body.includes('$ARGUMENTS')) return body.replaceAll('$ARGUMENTS', args);
  return `${body}\n\n${args}`;
}