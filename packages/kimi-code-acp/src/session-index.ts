/**
 * AIR session index (the subset the engine can serve):
 *
 * - `_session/batch_get`: rows for named sessions;
 * - `_session/list/subscribe` / `_session/list/unsubscribe`, with the
 *   `_session/list/changes` notification on the same connection.
 *
 * Archive/unarchive stay unimplemented (the public SDK exposes no archive
 * mutation), so this adapter advertises only the capabilities it serves.
 */
import { isAbsolute } from 'node:path';

import { RequestError } from '@agentclientprotocol/sdk/unstable';
import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

export const SESSION_BATCH_GET_METHOD = '_session/batch_get';
export const LIST_SUBSCRIBE_METHOD = '_session/list/subscribe';
export const LIST_UNSUBSCRIBE_METHOD = '_session/list/unsubscribe';
export const LIST_CHANGES_METHOD = '_session/list/changes';

/** The session row AIR renders (`SessionInfo` in the AIR schema). */
export interface SessionRow {
  readonly sessionId: string;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly title?: string;
  readonly updatedAt?: string;
  readonly archived?: boolean;
}

export interface BatchGetRequest {
  readonly sessionIds: readonly string[];
}

export interface SubscribeRequest {
  readonly cwd: string;
}

export interface UnsubscribeRequest {
  readonly subscriptionId: string;
}

export interface ListChanges {
  readonly subscriptionId: string;
  readonly sessions: readonly SessionRow[];
  readonly removed: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseBatchGetRequest(params: unknown): BatchGetRequest {
  const record = asRecord(params);
  const ids = record['sessionIds'];
  if (
    Object.keys(record).length !== 1 ||
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string' || id.trim().length === 0) ||
    new Set(ids).size !== ids.length
  ) {
    throw RequestError.invalidParams(
      undefined,
      'params require only sessionIds: distinct, non-blank strings',
    );
  }
  return { sessionIds: ids as string[] };
}

export function parseSubscribeRequest(params: unknown): SubscribeRequest {
  const cwd = asRecord(params)['cwd'];
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw RequestError.invalidParams({ cwd }, 'params require an absolute cwd');
  }
  return { cwd };
}

export function parseUnsubscribeRequest(params: unknown): UnsubscribeRequest {
  const subscriptionId = asRecord(params)['subscriptionId'];
  if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) {
    throw RequestError.invalidParams(undefined, 'params require a subscriptionId');
  }
  return { subscriptionId };
}

export function sessionRow(summary: {
  readonly id: string;
  readonly workDir: string;
  readonly additionalDirs?: readonly string[];
  readonly title?: string;
  readonly updatedAt: number;
  readonly archived?: boolean;
}): SessionRow {
  return {
    sessionId: summary.id,
    cwd: summary.workDir,
    additionalDirectories: summary.additionalDirs ?? [],
    ...(summary.title === undefined || summary.title.length === 0 ? {} : { title: summary.title }),
    updatedAt: new Date(summary.updatedAt).toISOString(),
    ...(summary.archived === true ? { archived: true } : {}),
  };
}

export async function batchGetSessions(
  harness: KimiHarness,
  request: BatchGetRequest,
): Promise<{ sessions: SessionRow[] }> {
  if (request.sessionIds.length === 0) return { sessions: [] };
  const rows: SessionRow[] = [];
  for (const sessionId of request.sessionIds) {
    const [summary] = await harness.listSessions({ sessionId, includeArchived: true });
    if (summary === undefined) {
      throw new RequestError(-32002, `Session not found: ${sessionId}`, { sessionId });
    }
    rows.push(sessionRow(summary));
  }
  return { sessions: rows };
}
