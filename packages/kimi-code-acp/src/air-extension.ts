/**
 * The AIR (JetBrains) extension namespace.
 *
 * AIR declares itself in `initialize.clientCapabilities._meta.jetbrains.air`
 * as `{version, capabilities: string[]}`, and the agent answers with its own
 * `jetbrains.air` object. Only that client gets the extension payloads; every
 * other client (Zed included) gets the plain ACP surface.
 *
 * Implemented here: the goal payload on session info updates and
 * `_session/rename`. Archive/unarchive and native subagent sessions are not
 * wired yet (see the coverage note).
 */
import { RequestError } from '@agentclientprotocol/sdk/unstable';

export const AIR_META_KEY = 'jetbrains';
export const AIR_NAMESPACE = 'air';
export const AIR_VERSION = 1;
export const RENAME_METHOD = '_session/rename';
export const SET_TITLE_METHOD = 'session/set_title';

export interface AirExtension {
  readonly version: number;
  readonly capabilities: readonly string[];
}

/** What this adapter implements of the AIR capability list. */
export const AIR_AGENT_CAPABILITIES = [
  'sessionIndex',
  'sessionBatchGet',
  'sessionRename',
  'sessionListSubscribe',
  'goal',
] as const;

/** The AIR extension a client declared, if it is AIR at all. */
export function airExtension(clientCapabilities: unknown): AirExtension | undefined {
  const meta = (clientCapabilities as { readonly _meta?: unknown } | null | undefined)?._meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  const jetbrains = (meta as Record<string, unknown>)[AIR_META_KEY];
  if (typeof jetbrains !== 'object' || jetbrains === null) return undefined;
  const air = (jetbrains as Record<string, unknown>)[AIR_NAMESPACE];
  if (typeof air !== 'object' || air === null) return undefined;
  const record = air as Record<string, unknown>;
  const version = record['version'];
  if (typeof version !== 'number' || !Number.isFinite(version)) return undefined;
  const capabilities = Array.isArray(record['capabilities'])
    ? record['capabilities'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { version, capabilities };
}

/** `_meta` carrying one AIR payload (merged with any other namespace keys). */
export function airMeta(
  payloads: Readonly<Record<string, unknown>>,
  base: Record<string, unknown> | undefined = undefined,
): Record<string, unknown> {
  const jetbrains = (base?.[AIR_META_KEY] as Record<string, unknown> | undefined) ?? {};
  const air = (jetbrains[AIR_NAMESPACE] as Record<string, unknown> | undefined) ?? {};
  return {
    ...(base ?? {}),
    [AIR_META_KEY]: {
      ...jetbrains,
      [AIR_NAMESPACE]: { version: AIR_VERSION, ...air, ...payloads },
    },
  };
}

/** The goal capability payload the agent advertises to AIR. */
export function airGoalCapability(): {
  version: number;
  controlMethod: string;
  actions: readonly string[];
} {
  return { version: 1, controlMethod: '_session/goal', actions: ['set', 'clear'] };
}

export interface RenameRequest {
  readonly sessionId: string;
  readonly title: string;
}

/** `session/set_title` uses the same params shape. */
export const parseSetTitleRequest = parseRenameRequest;

export function parseRenameRequest(params: unknown): RenameRequest {
  if (typeof params !== 'object' || params === null) {
    throw RequestError.invalidParams(undefined, 'rename params must be an object');
  }
  const record = params as Record<string, unknown>;
  const sessionId = record['sessionId'];
  const title = record['title'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw RequestError.invalidParams(undefined, 'rename params require a non-empty sessionId');
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw RequestError.invalidParams(undefined, 'rename params require a non-empty title');
  }
  return { sessionId, title: title.trim() };
}