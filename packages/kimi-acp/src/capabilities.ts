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
}

const NONE: ClientCapabilities = { terminalOutput: false, terminalOutputDelta: false };

type MetaCarrier = { readonly _meta?: Record<string, unknown> | null | undefined } | null | undefined;

function metaFlag(meta: Record<string, unknown> | null | undefined, key: string): boolean {
  return meta?.[key] === true;
}

export function readClientCapabilities(capabilities: MetaCarrier): ClientCapabilities {
  const meta = capabilities?._meta;
  if (meta === undefined || meta === null) return NONE;
  const delta = metaFlag(meta, 'terminal_output_delta');
  return {
    terminalOutput: delta || metaFlag(meta, 'terminal_output'),
    terminalOutputDelta: delta,
  };
}
