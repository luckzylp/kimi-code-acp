/**
 * What the client told us it can render, read once from `initialize`.
 *
 * Every capability here has a degradation path (ADR 0001, Decision 3): nothing
 * may depend on a capability being present, because the ACP spec promises less
 * than any given client implements — Zed 1.29, for example, never sends
 * `terminal/output`'s `exitStatus` even though the spec defines it.
 */
export interface ClientCapabilities {
  /** `_meta.terminal_output`: renders a terminal from `_meta.terminal_info` + `terminal_output` + `terminal_exit`. */
  readonly terminalOutput: boolean;
  /** `_meta.terminal_output_delta`: appends `terminal_output_delta` chunks instead of replacement chunks. */
  readonly terminalOutputDelta: boolean;
  /** `elicitation.form`: renders a form from a requested schema. */
  readonly elicitationForm: boolean;
  /** `fs.readTextFile`: the client serves file reads. */
  readonly fsRead: boolean;
  /** `fs.writeTextFile`: the client serves file writes. */
  readonly fsWrite: boolean;
  /** `session.promptSuggestions`: the client renders a predicted next prompt. */
  readonly promptSuggestions: boolean;
  /** `session.cursors`: the client accepts `cursor_update` and may rewind. */
  readonly cursors: boolean;
  /** `session.notices`: the client renders structured notices. */
  readonly notices: boolean;
}

const NONE: ClientCapabilities = {
  terminalOutput: false,
  terminalOutputDelta: false,
  elicitationForm: false,
  fsRead: false,
  fsWrite: false,
  promptSuggestions: false,
  cursors: false,
  notices: false,
};

type CapabilitiesCarrier =
  | {
      readonly _meta?: Record<string, unknown> | null | undefined;
      readonly session?: unknown;
      readonly fs?: { readonly readTextFile?: boolean; readonly writeTextFile?: boolean } | null | undefined;
      readonly elicitation?: { readonly form?: object | null } | null | undefined;
    }
  | null
  | undefined;

function metaFlag(meta: Record<string, unknown> | null | undefined, key: string): boolean {
  return meta?.[key] === true;
}

export function readClientCapabilities(capabilities: CapabilitiesCarrier): ClientCapabilities {
  const meta = capabilities?._meta;
  const delta = metaFlag(meta, 'terminal_output_delta');
  const session = capabilities?.session as
    | { readonly promptSuggestions?: unknown; readonly cursors?: unknown; readonly notices?: unknown }
    | null
    | undefined;
  return {
    terminalOutput: delta || metaFlag(meta, 'terminal_output'),
    terminalOutputDelta: delta,
    elicitationForm: capabilities?.elicitation?.form !== undefined && capabilities?.elicitation?.form !== null,
    fsRead: capabilities?.fs?.readTextFile === true,
    fsWrite: capabilities?.fs?.writeTextFile === true,
    promptSuggestions: session?.promptSuggestions != null,
    cursors: session?.cursors != null,
    notices: session?.notices != null,
  };
}
/**
 * v2 capability mapping: the draft keeps prompt suggestions and elicitation on
 * the client capabilities (there is no v2 terminal/fs capability).
 */
export function readV2Capabilities(capabilities: unknown): ClientCapabilities {
  const record = (capabilities ?? {}) as Record<string, unknown>;
  const session = record['session'] as { readonly promptSuggestions?: unknown } | undefined;
  const elicitation = record['elicitation'] as { readonly form?: unknown } | undefined;
  return {
    ...NONE,
    promptSuggestions: session?.promptSuggestions != null,
    elicitationForm: elicitation?.form != null,
  };
}
