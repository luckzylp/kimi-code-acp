/**
 * Tool-call projection (ADR 0001, Decision 4).
 *
 * The engine runs tools in-process — including Bash — so the client renders a
 * **shadow** of work it does not own: a tool card plus, for commands, a
 * display terminal fed through the v1 `_meta` channel that codex-acp and
 * claude-agent-acp use and Zed consumes since 1.29:
 *
 *   tool_call._meta.terminal_info            { terminal_id, cwd }
 *   tool_call_update._meta.terminal_output   { terminal_id, data }
 *   tool_call_update._meta.terminal_exit     { terminal_id, exit_code, signal }
 *
 * Degradation (ADR Decision 3): a client without the capability gets the
 * command's output once, in the final update, never a re-sent buffer per chunk.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type {
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk/unstable';
import type { ToolCallDeltaEvent, ToolCallStartedEvent, ToolResultEvent, ToolUpdatedEvent } from '@moonshot-ai/kimi-code-sdk';
import type { ToolInputDisplay } from '@moonshot-ai/agent-core-v2/tool/toolInputDisplay';

/** Bytes inspected to tell a text file from a blob. */
const SNIFF_BYTES = 8 * 1024;
/** Characters of a tool result kept in the card; the model has the full text. */
const RESULT_PREVIEW_CHARS = 16 * 1024;
/** Argument growth before another streamed update is worth a re-render. */
const ARG_GROWTH_CHARS = 32;
/** Argument stream stall after which the pending tail is flushed. */
const ARG_STALL_MS = 120;
/** Output bytes buffered before a terminal update is pushed. */
const TERMINAL_FLUSH_CHARS = 8 * 1024;
/** Output age at which a partial terminal update is pushed anyway. */
const TERMINAL_FLUSH_MS = 50;

export function acpToolCallId(turnId: number, toolCallId: string): string {
  return `${turnId}:${toolCallId}`;
}

/** The ACP tool kind for an engine tool name. */
export function toolKind(name: string): ToolKind {
  switch (name) {
    case 'Read':
    case 'Glob':
    case 'Grep':
      return 'read';
    case 'Write':
    case 'Edit':
      return 'edit';
    case 'Bash':
      return 'execute';
    case 'WebFetch':
    case 'WebSearch':
      return 'fetch';
    case 'Think':
      return 'think';
    default:
      return 'other';
  }
}

function acpStatus(status: string): ToolCallStatus {
  switch (status) {
    case 'running':
    case 'stopping':
      return 'in_progress';
    case 'success':
      return 'completed';
    case 'aborted':
    case 'failed':
      return 'failed';
    default:
      return 'in_progress';
  }
}

/** A regular, readable text file — the only kind of path a location may name. */
function isReadableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    if (stat.size === 0) return true;
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, SNIFF_BYTES));
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      return !buffer.subarray(0, read).includes(0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function displayPath(display: ToolInputDisplay | undefined): string | undefined {
  if (display === undefined) return undefined;
  if (display.kind === 'file_io' || display.kind === 'diff') return display.path;
  return undefined;
}

function argsPath(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ['file_path', 'path']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Locations the client may open: absolute paths that are regular text files. */
export function toolCallLocations(
  args: unknown,
  display: ToolInputDisplay | undefined,
  cwd: string,
): ToolCallLocation[] | undefined {
  for (const candidate of [displayPath(display), argsPath(args)]) {
    if (candidate === undefined) continue;
    const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    if (isReadableFile(absolute)) return [{ path: absolute }];
  }
  return undefined;
}

function startContent(event: ToolCallStartedEvent): ToolCallContent[] {
  const content: ToolCallContent[] = [];
  const display = event.display;
  if (display?.kind === 'diff') {
    content.push({
      type: 'diff',
      path: display.path,
      oldText: display.before,
      newText: display.after,
    });
  }
  if (display?.kind === 'command') {
    const cwd = display.cwd === undefined ? '' : `# ${display.cwd}\n`;
    content.push({
      type: 'content',
      content: { type: 'text', text: `${cwd}$ ${display.command}` },
    });
  } else {
    content.push({ type: 'content', content: { type: 'text', text: stringifyArgs(event.args) } });
  }
  return content;
}

/**
 * One bounded preview of a tool result, as a card's content.
 *
 * A command's output is fenced: clients render tool content as markdown, so an
 * unfenced result reads as prose next to the command block the card started
 * with. The omission notice stays outside the fence.
 */
export function resultContent(
  output: unknown,
  options: { readonly codeBlock?: boolean } = {},
): ToolCallContent[] {
  const text = resultText(output);
  if (text.length === 0) return [];
  const truncated = text.length > RESULT_PREVIEW_CHARS;
  const omitted = text.length - RESULT_PREVIEW_CHARS;
  const shown = truncated ? text.slice(omitted) : text;
  const notice = truncated ? `… ${omitted.toLocaleString('en-US')} earlier characters omitted …\n` : '';
  const body = options.codeBlock === true ? `${notice}${fenced(shown)}` : `${notice}${shown}`;
  return [{ type: 'content', content: { type: 'text', text: body } }];
}

/** A fence longer than any backtick run inside `text`, so the block cannot close early. */
function fenced(text: string): string {
  let longest = 0;
  let run = 0;
  for (const character of text) {
    run = character === '`' ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}\n${text.replace(/\n$/, '')}\n${ticks}`;
}

function resultText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && part !== null) {
          const record = part as Record<string, unknown>;
          if (typeof record['text'] === 'string') return record['text'];
        }
        return '';
      })
      .join('');
  }
  if (output === undefined || output === null) return '';
  try {
    return JSON.stringify(output, null, 2) ?? String(output);
  } catch {
    return String(output);
  }
}

function stringifyArgs(args: unknown): string {
  try {
    return JSON.stringify(args) ?? String(args);
  } catch {
    return String(args);
  }
}

/** Per-call state the projection needs across events. */
interface TrackedCall {
  readonly acpId: string;
  readonly name: string;
  readonly title: string;
  readonly kind: ToolKind;
  argsText: string;
  argsLengthAtFlush: number;
  argsTimer: ReturnType<typeof setTimeout> | undefined;
  readonly terminalId: string | undefined;
  terminalBuffer: string;
  terminalTimer: ReturnType<typeof setTimeout> | undefined;
  exitCode: number | undefined;
  signal: string | undefined;
  readonly startedAt: number;
  finished: boolean;
}

export interface ToolCallsOptions {
  readonly sessionId: string;
  readonly cwd: () => string;
  /** `_meta.terminal_output` is rendered by the client. */
  readonly shadowTerminals: boolean;
  /** The client appends `_meta.terminal_output_delta` chunks itself. */
  readonly terminalOutputDelta?: boolean;
  readonly emit: (notification: SessionNotification) => void;
  readonly now?: () => number;
}

export class ToolCalls {
  private readonly calls = new Map<string, TrackedCall>();
  private readonly now: () => number;

  constructor(private readonly options: ToolCallsOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** The card to attach a permission request to, while the call is pending. */
  pendingCall(toolCallId: string): ToolCallUpdate | undefined {
    const call = this.calls.get(toolCallId);
    if (call === undefined) return undefined;
    return {
      toolCallId: call.acpId,
      title: call.title,
      kind: call.kind,
      status: 'in_progress',
      rawInput: parseArgs(call.argsText),
    };
  }

  started(event: ToolCallStartedEvent): void {
    const acpId = acpToolCallId(event.turnId, event.toolCallId);
    const kind = toolKind(event.name);
    const command = commandOf(event.display, event.args);
    // Zed renders an execute tool's title as the command (a wrapping code block
    // in the card, and the display terminal's label), so the title must be the
    // command itself; a verb like "Running" would hide it.
    const title =
      event.display?.kind === 'command' && command !== undefined
        ? command
        : event.description ?? event.name;
    const terminalId = this.options.shadowTerminals && kind === 'execute' && command !== undefined ? acpId : undefined;
    const call: TrackedCall = {
      acpId,
      name: event.name,
      title,
      kind,
      argsText: stringifyArgs(event.args),
      argsLengthAtFlush: stringifyArgs(event.args).length,
      argsTimer: undefined,
      terminalId,
      terminalBuffer: '',
      terminalTimer: undefined,
      exitCode: undefined,
      signal: undefined,
      startedAt: this.now(),
      finished: false,
    };
    this.calls.set(event.toolCallId, call);

    // A call with a display terminal carries the terminal and nothing else.
    // `content` in an update *replaces* the collection (ACP schema), so any
    // text block sent beside it would drop the terminal on the next update and
    // leave the output as prose. The command is the card's title already.
    const content: ToolCallContent[] =
      terminalId === undefined ? startContent(event) : [{ type: 'terminal', terminalId }];
    this.emit({
      sessionId: this.options.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: acpId,
        title,
        kind,
        status: 'pending',
        content,
        rawInput: event.args,
        locations: toolCallLocations(event.args, event.display, this.options.cwd()),
        ...(terminalId === undefined
          ? {}
          : { _meta: { terminal_info: { terminal_id: terminalId, cwd: commandCwd(event.display, this.options.cwd()) } } }),
      },
    });
  }

  /** Argument deltas, streamed coarsely — the started upgrade carries the full set. */
  delta(event: ToolCallDeltaEvent): void {
    const call = this.calls.get(event.toolCallId);
    if (call === undefined) return;
    call.argsText += event.argumentsPart ?? '';
    if (call.argsText.length - call.argsLengthAtFlush < ARG_GROWTH_CHARS) {
      call.argsTimer ??= this.armArgsFlush(call);
      return;
    }
    this.flushArgs(call);
  }

  updated(event: ToolUpdatedEvent): void {
    const call = this.calls.get(event.toolCallId);
    if (call === undefined) return;
    const task = event.fields['task'];
    if (typeof task === 'object' && task !== null) {
      const record = task as Record<string, unknown>;
      if (typeof record['exitCode'] === 'number') call.exitCode = record['exitCode'];
    }
    if (typeof event.fields['signal'] === 'string') call.signal = event.fields['signal'];

    if (event.output !== undefined && call.terminalId !== undefined && event.output.text.length > 0) {
      call.terminalBuffer += event.output.text;
      if (call.terminalBuffer.length >= TERMINAL_FLUSH_CHARS) {
        this.flushTerminal(call);
      } else {
        call.terminalTimer ??= this.armTerminalFlush(call);
      }
    }

    this.emit({
      sessionId: this.options.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: call.acpId,
        status: acpStatus(event.status),
        ...(event.detached ? { _meta: { detached: true } } : {}),
      },
    });
  }

  result(event: ToolResultEvent): void {
    const call = this.calls.get(event.toolCallId);
    if (call === undefined) return;
    this.flushArgs(call);
    this.flushTerminal(call);
    const status: ToolCallStatus = event.isError === true ? 'failed' : 'completed';
    const meta =
      call.terminalId === undefined
        ? {}
        : {
            terminal_exit: {
              terminal_id: call.terminalId,
              exit_code: call.exitCode ?? (event.isError === true ? 1 : 0),
              signal: call.signal ?? null,
            },
          };
    // Same replacement rule: a terminal card keeps its terminal, and the
    // output arrives through `_meta.terminal_output`; a card without one gets
    // the result as text (fenced for a command, so it reads like the command).
    const content =
      call.terminalId === undefined ? resultContent(event.output, { codeBlock: call.kind === 'execute' }) : [];
    this.emit({
      sessionId: this.options.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: call.acpId,
        status,
        ...(content.length === 0 ? {} : { content }),
        rawOutput: event.output,
        ...(Object.keys(meta).length === 0 ? {} : { _meta: meta }),
      },
    });
    call.finished = true;
    this.clear(call);
    this.calls.delete(event.toolCallId);
  }

  /**
   * Close calls of a turn that ended without a result event (interrupted or
   * detached). A client keeps a stale in-progress card — and may keep the
   * composer disabled — until every call reaches a terminal status.
   */
  settleTurn(turnId: number, status: 'completed' | 'failed'): void {
    for (const [toolCallId, call] of this.calls) {
      if (call.finished || !call.acpId.startsWith(`${turnId}:`)) continue;
      this.flushArgs(call);
      this.flushTerminal(call);
      call.finished = true;
      const meta =
        call.terminalId === undefined
          ? {}
          : {
              terminal_exit: {
                terminal_id: call.terminalId,
                exit_code: call.exitCode ?? (status === 'failed' ? 1 : 0),
                signal: call.signal ?? null,
              },
            };
      this.emit({
        sessionId: this.options.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: call.acpId,
          status,
          ...(Object.keys(meta).length === 0 ? {} : { _meta: meta }),
        },
      });
      this.clear(call);
      this.calls.delete(toolCallId);
    }
  }

  /** Drop timers for every in-flight call, e.g. when the session closes. */
  dispose(): void {
    for (const call of this.calls.values()) this.clear(call);
    this.calls.clear();
  }

  private clear(call: TrackedCall): void {
    if (call.argsTimer !== undefined) clearTimeout(call.argsTimer);
    if (call.terminalTimer !== undefined) clearTimeout(call.terminalTimer);
  }

  private armArgsFlush(call: TrackedCall): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      call.argsTimer = undefined;
      this.flushArgs(call);
    }, ARG_STALL_MS);
    timer.unref?.();
    return timer;
  }

  private flushArgs(call: TrackedCall): void {
    if (call.argsTimer !== undefined) {
      clearTimeout(call.argsTimer);
      call.argsTimer = undefined;
    }
    if (call.argsText.length === call.argsLengthAtFlush) return;
    call.argsLengthAtFlush = call.argsText.length;
    // The terminal owns the content of a command card; replacing it with the
    // streaming arguments would take the running output off the screen.
    if (call.terminalId !== undefined) return;
    this.emit({
      sessionId: this.options.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: call.acpId,
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: call.argsText } }],
      },
    });
  }

  private armTerminalFlush(call: TrackedCall): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      call.terminalTimer = undefined;
      this.flushTerminal(call);
    }, TERMINAL_FLUSH_MS);
    timer.unref?.();
    return timer;
  }

  private flushTerminal(call: TrackedCall): void {
    if (call.terminalTimer !== undefined) {
      clearTimeout(call.terminalTimer);
      call.terminalTimer = undefined;
    }
    if (call.terminalBuffer.length === 0 || call.terminalId === undefined) return;
    const data = call.terminalBuffer;
    call.terminalBuffer = '';
    this.emit({
      sessionId: this.options.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: call.acpId,
        _meta:
          this.options.terminalOutputDelta === true
            ? { terminal_output_delta: { terminal_id: call.terminalId, data } }
            : { terminal_output: { terminal_id: call.terminalId, data } },
      },
    });
  }

  private emit(notification: SessionNotification): void {
    this.options.emit(notification);
  }
}

function parseArgs(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function commandOf(display: ToolInputDisplay | undefined, args: unknown): string | undefined {
  if (display?.kind === 'command') return display.command;
  if (typeof args === 'object' && args !== null) {
    const command = (args as Record<string, unknown>)['command'];
    if (typeof command === 'string' && command.length > 0) return command;
  }
  return undefined;
}

function commandCwd(display: ToolInputDisplay | undefined, fallback: string): string {
  if (display?.kind === 'command' && display.cwd !== undefined) return display.cwd;
  return fallback;
}