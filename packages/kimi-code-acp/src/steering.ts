/**
 * ACP steering extension (`_session/steering`), as claude-agent-acp defines it.
 *
 * A client that advertises support (by reading `initialize._meta.steering`)
 * may inject a message into the turn that is currently running instead of
 * queueing a second `session/prompt`. The adapter forwards it to the engine's
 * `Session.steer`, which folds the message into the live turn.
 *
 * Idle behavior is host-owned: a client may opt into
 * `_meta.steering.idleBehavior: 'promptRequired'` and start the turn itself
 * with a normal `session/prompt`; without the opt-in, the adapter starts a
 * detached turn and answers `startedNewTurn` (the compatibility default).
 */
import { RequestError, type ContentBlock } from '@agentclientprotocol/sdk/unstable';

export const STEER_METHOD = '_session/steering';

export interface SteerRequest {
  readonly sessionId: string;
  readonly prompt: readonly ContentBlock[];
  readonly _meta?: {
    readonly steering?: { readonly idleBehavior?: 'promptRequired' };
  } | null;
}

export type SteerResponse =
  | { readonly outcome: 'injected' }
  | { readonly outcome: 'startedNewTurn' }
  | { readonly outcome: 'promptRequired'; readonly reason: 'noRunningTurn' };

/** The `initialize` capability that tells a client steering is available. */
export const STEERING_CAPABILITY = { steering: { supported: true } } as const;

/** Validate raw params; unknown content blocks are tolerated by the converter. */
export function parseSteerRequest(params: unknown): SteerRequest {
  if (typeof params !== 'object' || params === null) {
    throw RequestError.invalidParams(undefined, 'steer params must be an object');
  }
  const record = params as Record<string, unknown>;
  const sessionId = record['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw RequestError.invalidParams(undefined, 'steer params require a non-empty sessionId');
  }
  const prompt = record['prompt'];
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw RequestError.invalidParams(undefined, 'steer params require a non-empty prompt array');
  }
  const meta = record['_meta'];
  const steeringMeta =
    typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>)['steering'] : undefined;
  const idleBehavior =
    typeof steeringMeta === 'object' && steeringMeta !== null
      ? (steeringMeta as Record<string, unknown>)['idleBehavior']
      : undefined;
  if (idleBehavior !== undefined && idleBehavior !== 'promptRequired') {
    throw RequestError.invalidParams(undefined, 'unsupported steering idleBehavior');
  }
  return {
    sessionId,
    prompt: prompt as ContentBlock[],
    ...(idleBehavior === undefined ? {} : { _meta: { steering: { idleBehavior } } }),
  };
}