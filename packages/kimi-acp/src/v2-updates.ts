/**
 * ACP v1 → v2 update translation (experimental draft v2).
 *
 * The run model, tool projection and activity cards are written against ACP
 * v1's session updates. v2 keeps the same envelope (`session/update` with
 * `{sessionId, update}`) but changes the update vocabulary:
 *
 * - tool cards and their progress are one `tool_call_update` (there is no
 *   separate `tool_call`), and v2 tool calls carry `name`;
 * - plans are `plan_update` with structured entries;
 * - display terminals are first-class (`terminal_update`,
 *   `terminal_output_chunk`) instead of `_meta.terminal_*`;
 * - foreground state is explicit (`state_update` running/idle), because v2's
 *   `session/prompt` response carries no stop reason.
 *
 * Everything not listed here is dropped rather than guessed at.
 */
import { randomUUID } from 'node:crypto';

import type { SessionNotification } from '@agentclientprotocol/sdk/unstable';

type V2Update = Record<string, unknown>;

/** Translate one v1 notification into the v2 updates that replace it. */
export function toV2Updates(notification: SessionNotification): V2Update[] {
  const update = notification.update as Record<string, unknown> & { sessionUpdate: string };
  const meta = update['_meta'] as Record<string, unknown> | undefined;
  switch (update['sessionUpdate']) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return [
        {
          sessionUpdate: update['sessionUpdate'],
          messageId: update['messageId'] ?? randomUUID(),
          content: update['content'],
        },
      ];
    case 'tool_call': {
      const terminal = terminalInfo(meta);
      const base: V2Update = {
        sessionUpdate: 'tool_call_update',
        toolCallId: update['toolCallId'],
        ...(typeof update['title'] === 'string' ? { name: update['title'], title: update['title'] } : {}),
        ...(update['kind'] === undefined ? {} : { kind: update['kind'] }),
        ...(update['status'] === undefined ? {} : { status: update['status'] }),
        ...(update['content'] === undefined ? {} : { content: update['content'] }),
        ...(update['locations'] === undefined ? {} : { locations: update['locations'] }),
        ...(update['rawInput'] === undefined ? {} : { rawInput: update['rawInput'] }),
      };
      return terminal === undefined
        ? [base]
        : [base, { sessionUpdate: 'terminal_update', terminalId: terminal.id, ...(terminal.cwd === undefined ? {} : { cwd: terminal.cwd }) }];
    }
    case 'tool_call_update': {
      const base: V2Update = {
        sessionUpdate: 'tool_call_update',
        toolCallId: update['toolCallId'],
        ...(update['status'] === undefined ? {} : { status: update['status'] }),
        ...(update['content'] === undefined ? {} : { content: update['content'] }),
        ...(update['rawOutput'] === undefined ? {} : { rawOutput: update['rawOutput'] }),
        ...(update['locations'] === undefined ? {} : { locations: update['locations'] }),
        ...(update['rawInput'] === undefined ? {} : { rawInput: update['rawInput'] }),
      };
      const out: V2Update[] = [base];
      const output = meta?.['terminal_output'] as { terminal_id?: string; data?: string } | undefined;
      if (typeof output?.terminal_id === 'string' && typeof output.data === 'string') {
        out.push({ sessionUpdate: 'terminal_output_chunk', terminalId: output.terminal_id, data: output.data });
      }
      const exit = meta?.['terminal_exit'] as
        | { terminal_id?: string; exit_code?: number; signal?: string | null }
        | undefined;
      if (typeof exit?.terminal_id === 'string') {
        out.push({
          sessionUpdate: 'terminal_update',
          terminalId: exit.terminal_id,
          exitStatus:
            exit.exit_code === undefined
              ? null
              : { exitCode: exit.exit_code, signal: exit.signal ?? null },
        });
      }
      return out;
    }
    case 'plan':
      return [
        {
          sessionUpdate: 'plan_update',
          plan: {
            type: 'items',
            planId: 'plan',
            entries: update['entries'],
          },
        },
      ];
    case 'config_option_update': {
      const options = Array.isArray(update['configOptions']) ? update['configOptions'] : [];
      return [
        {
          sessionUpdate: 'config_option_update',
          configOptions: toV2ConfigOptions(options as Record<string, unknown>[]),
        },
      ];
    }
    case 'available_commands_update':
    case 'session_info_update':
    case 'usage_update':
      return [{ sessionUpdate: update['sessionUpdate'], ...rest(update) }];
    default:
      return [];
  }
}

/** v1 config options → v2 (`configId` instead of `id`). */
export function toV2ConfigOptions(options: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return options.map((option) => ({
    type: 'select',
    configId: option['id'],
    name: option['name'],
    ...(option['category'] === undefined ? {} : { category: option['category'] }),
    currentValue: option['currentValue'],
    options: option['options'],
  }));
}

/** Foreground state updates: v2 clients learn a turn ended from these. */
export function stateUpdate(state: 'running' | 'idle' | 'requires_action'): V2Update {
  return { sessionUpdate: 'state_update', state };
}

function terminalInfo(meta: Record<string, unknown> | undefined): { id: string; cwd?: string } | undefined {
  const info = meta?.['terminal_info'] as { terminal_id?: string; cwd?: string } | undefined;
  if (typeof info?.terminal_id !== 'string') return undefined;
  return { id: info.terminal_id, ...(typeof info.cwd === 'string' ? { cwd: info.cwd } : {}) };
}

function rest(update: Record<string, unknown>): Record<string, unknown> {
  const { sessionUpdate: _ignored, ...others } = update;
  return others;
}