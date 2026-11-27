/**
 * The AIR goal extension, as claude-agent-acp defines it.
 *
 * JetBrains AIR drives long-running goals through `_session/goal` rather than
 * slash commands: `set` starts (or replaces) the goal, `clear` stops it. The
 * adapter maps both onto the engine's goal service; the goal card in the
 * transcript and the `/goal` command read the same state.
 *
 * The optional `_meta.jetbrains.air.goal` publication is not sent: it only
 * feeds AIR's own panel, and a `session_info_update` without a title would
 * clear the thread title in clients that treat it as authoritative.
 */
import { RequestError } from '@agentclientprotocol/sdk/unstable';

export const GOAL_METHOD = '_session/goal';

export type GoalRequest =
  | { readonly sessionId: string; readonly action: 'clear' }
  | { readonly sessionId: string; readonly action: 'set'; readonly objective: string };

export function parseGoalRequest(params: unknown): GoalRequest {
  if (typeof params !== 'object' || params === null) {
    throw RequestError.invalidParams(undefined, 'goal params must be an object');
  }
  const record = params as Record<string, unknown>;
  const sessionId = record['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw RequestError.invalidParams(undefined, 'goal params require a non-empty sessionId');
  }
  if (record['action'] === 'clear') return { sessionId, action: 'clear' };
  if (record['action'] === 'set') {
    const objective = record['objective'];
    if (typeof objective !== 'string' || objective.trim().length === 0) {
      throw RequestError.invalidParams(undefined, 'goal set requires a non-empty objective');
    }
    return { sessionId, action: 'set', objective: objective.trim() };
  }
  throw RequestError.invalidParams(undefined, "goal action must be 'set' or 'clear'");
}
