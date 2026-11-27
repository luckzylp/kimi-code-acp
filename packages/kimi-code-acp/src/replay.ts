/**
 * `session/load` history replay (ADR 0001, Decision 4).
 *
 * The engine persists a session's context; ACP has no bulk history call, so the
 * loaded session's records are projected into the same `session/update`
 * notifications a live turn produces. Two rules keep replay honest:
 *
 * - **Injected context is not speech.** The engine folds reminders into a user
 *   turn — today's date, the permission mode, todo nudges, AGENTS.md notes — and
 *   wraps them in `<system-reminder>`. Replaying them as the user's words both
 *   leaks instructions nobody typed and shows history the live turn never
 *   showed. They are stripped, and an empty remainder is dropped.
 * - **Engine-started turns read like they did live.** A task notification is
 *   replayed as the same one-line introduction the live turn posts
 *   (`engine-turn.ts`), not as a wall of XML.
 *
 * The record shape is structural on purpose: the SDK's replay type is generated
 * from the engine and this projection only reads the message fields.
 */
import type { SessionNotification } from '@agentclientprotocol/sdk/unstable';

import { goalCard, planNotification, type GoalSnapshotLike, type TodoLike } from './activity';
import { describeEngineTurn, isAutonomousOrigin } from './engine-turn';
import { resultContent, toolKind } from './tool-calls';

/** One content part, as much as this projection reads. */
interface ReplayPart {
  readonly type: string;
  readonly text?: string;
  readonly think?: string;
  readonly hidden?: boolean;
}

interface ReplayToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string | null;
}

/** One persisted message, as much as this projection reads. */
interface ReplayMessage {
  readonly role: string;
  readonly content: readonly ReplayPart[];
  readonly origin?: unknown;
  readonly id?: string;
  readonly toolCalls?: readonly ReplayToolCall[];
  readonly toolCallId?: string;
  readonly isError?: boolean;
}

/** The subset of the engine's replay records this projection reads. */
export interface ReplayRecord {
  readonly type: string;
  readonly message?: ReplayMessage;
  /** Present on `goal_updated` records. */
  readonly snapshot?: GoalSnapshotLike | null;
}

/** Markers that wrap context nobody typed: reminders, task notices, local commands. */
const STRIP_TAGS = [
  'system-reminder',
  'task-notification',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
];

/** Remove every `<tag>…</tag>` marker (nearest matching close), leaving speech. */
export function stripInjectedMarkers(text: string): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] === '<') {
      const tag = STRIP_TAGS.find((candidate) => text.startsWith(`<${candidate}>`, index));
      if (tag !== undefined) {
        const end = text.indexOf(`</${tag}>`, index + tag.length + 2);
        if (end !== -1) {
          index = end + tag.length + 3;
          continue;
        }
      }
    }
    result += text[index];
    index += 1;
  }
  return result;
}

/** Project the persisted replay of one agent into ACP notifications, in order. */
export function projectReplay(
  sessionId: string,
  records: readonly ReplayRecord[],
): SessionNotification[] {
  const out: SessionNotification[] = [];
  let turnId = 0;
  const toolCallTurns = new Map<string, number>();

  for (const record of records) {
    if (record.type === 'goal_updated') {
      if (record.snapshot !== null && record.snapshot !== undefined) {
        out.push(goalCard(sessionId, record.snapshot));
      }
      continue;
    }
    if (record.type !== 'message') continue;
    const message = record.message;
    if (message === undefined) continue;
    if (message.role === 'user') {
      const text = textOf(message.content);
      if (text === undefined) continue;
      if (isAutonomousOrigin(message.origin)) {
        const note = describeEngineTurn(message.origin, text);
        if (note !== undefined) out.push(userChunk(sessionId, note));
        continue;
      }
      const speech = stripInjectedMarkers(text).trim();
      if (speech.length > 0) out.push(userChunk(sessionId, speech, message.id));
      continue;
    }
    if (message.role === 'assistant') {
      turnId += 1;
      for (const part of message.content) {
        const update = assistantPart(sessionId, part);
        if (update !== null) out.push(update);
      }
      for (const toolCall of message.toolCalls ?? []) {
        toolCallTurns.set(toolCall.id, turnId);
        if (toolCall.name === 'TodoList') {
          // The todo list is the session's plan, not a card: restore it as one.
          const todos = todoItemsOf(toolCall.arguments);
          const plan = planNotification(sessionId, todos);
          if (plan !== null) out.push(plan);
          continue;
        }
        out.push(toolCallCard(sessionId, turnId, toolCall));
      }
      continue;
    }
    if (message.role === 'tool') {
      const turn = message.toolCallId === undefined ? undefined : toolCallTurns.get(message.toolCallId);
      if (turn === undefined || message.toolCallId === undefined) continue;
      out.push(toolResultUpdate(sessionId, turn, message.toolCallId, message));
    }
  }
  return out;
}

function textOf(content: readonly ReplayPart[]): string | undefined {
  const text = content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('');
  return text.length === 0 ? undefined : text;
}

function userChunk(sessionId: string, text: string, messageId?: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'user_message_chunk',
      ...(messageId === undefined ? {} : { messageId }),
      content: { type: 'text', text },
    },
  };
}

/** Ids of the user prompts in a replay, in order, for cursor announcements. */
export function replayedUserMessageIds(records: readonly ReplayRecord[]): string[] {
  const ids: string[] = [];
  for (const record of records) {
    if (record.type !== 'message' || record.message === undefined) continue;
    const message = record.message;
    if (message.role !== 'user') continue;
    if (!isAutonomousOrigin(message.origin)) {
      const id = message.id;
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    }
  }
  return ids;
}

function assistantPart(sessionId: string, part: ReplayPart): SessionNotification | null {
  if (part.type === 'text' && (part.text ?? '').length > 0) {
    return {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part.text ?? '' } },
    };
  }
  if (part.type === 'think' && (part.think ?? '').length > 0 && part.hidden !== true) {
    return {
      sessionId,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: part.think ?? '' } },
    };
  }
  return null;
}

function toolCallCard(sessionId: string, turnId: number, toolCall: ReplayToolCall): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: `${turnId}:${toolCall.id}`,
      title: toolCall.name,
      kind: toolKind(toolCall.name),
      status: 'pending',
      rawInput: parseArguments(toolCall.arguments),
    },
  };
}

function toolResultUpdate(
  sessionId: string,
  turnId: number,
  toolCallId: string,
  message: ReplayMessage,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: `${turnId}:${toolCallId}`,
      status: message.isError === true ? 'failed' : 'completed',
      content: resultContent(textOf(message.content) ?? ''),
    },
  };
}

/** The `todos` a TodoList call persisted, when its arguments still parse. */
function todoItemsOf(args: string | null): TodoLike[] {
  const parsed = parseArguments(args);
  if (typeof parsed !== 'object' || parsed === null) return [];
  const todos = (parsed as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((item): TodoLike[] => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    const title = record['title'];
    const status = record['status'];
    return typeof title === 'string' && typeof status === 'string' ? [{ title, status }] : [];
  });
}

function parseArguments(args: string | null): unknown {
  if (args === null) return undefined;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}