/**
 * Session cursors and `_session/rewind` (AIR extension, draft RFD).
 *
 * A cursor names one position in the conversation: `before:<messageId>` sits
 * right before a user message. The adapter announces one for every user
 * message it shows (replayed or live) when the client declares the
 * `session.cursors` capability, and `_session/rewind` drops that message and
 * everything after it from the engine's context.
 *
 * The engine has no cursor notion, so the adapter keeps the ordered list of
 * user message ids and maps a cursor onto `undoHistory(count)`: one undo step
 * per user turn the client asked to drop.
 */
import { RequestError, type SessionNotification } from '@agentclientprotocol/sdk/unstable';

export const REWIND_METHOD = '_session/rewind';
export const CURSOR_BEFORE_MESSAGE = 'before:';

export interface RewindRequest {
  readonly sessionId: string;
  readonly cursorId: string;
}

export interface RewindResponse {
  readonly rewound: boolean;
  readonly reason?: string;
}

export function parseRewindRequest(params: unknown): RewindRequest {
  if (typeof params !== 'object' || params === null) {
    throw RequestError.invalidParams(undefined, 'rewind params must be an object');
  }
  const record = params as Record<string, unknown>;
  const sessionId = record['sessionId'];
  const cursorId = record['cursorId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw RequestError.invalidParams(undefined, 'rewind params require a non-empty sessionId');
  }
  if (typeof cursorId !== 'string' || cursorId.length === 0) {
    throw RequestError.invalidParams(undefined, 'rewind params require a non-empty cursorId');
  }
  return { sessionId, cursorId };
}

export function cursorIdForMessage(messageId: string): string {
  return `${CURSOR_BEFORE_MESSAGE}${messageId}`;
}

/** The user message id a cursor lies before, or undefined for a foreign id. */
export function messageIdOfCursor(cursorId: string): string | undefined {
  return cursorId.startsWith(CURSOR_BEFORE_MESSAGE)
    ? cursorId.slice(CURSOR_BEFORE_MESSAGE.length)
    : undefined;
}

/** An entity the client already holds, which a live cursor can sit after. */
export type CursorEntity =
  | { readonly type: 'agent_message'; readonly messageId: string }
  | { readonly type: 'user_message'; readonly messageId: string }
  | { readonly type: 'tool_call'; readonly toolCallId: string };

/**
 * A live cursor: the engine prompt id names the rewind point, and the anchor
 * is the entity the client holds right before it (v1 does not echo the prompt
 * the client sent, so the cursor sits after the previous entity).
 */
export function liveCursorUpdate(
  sessionId: string,
  promptId: string,
  anchor: CursorEntity,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'cursor_update',
      cursorId: cursorIdForMessage(promptId),
      anchor: { ...anchor, position: 'after' },
      capabilities: { fork: {}, rewind: {} },
    },
  } as SessionNotification;
}

/** The `cursor_update` announcing that a user message can be rewound to. */
export function cursorUpdate(sessionId: string, messageId: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'cursor_update',
      cursorId: cursorIdForMessage(messageId),
      anchor: { type: 'user_message', messageId, position: 'before' },
      // `rewind` is the AIR convention on top of the RFD's `fork`; clients that
      // do not know it ignore the key.
      capabilities: { fork: {}, rewind: {} },
    },
  } as SessionNotification;
}