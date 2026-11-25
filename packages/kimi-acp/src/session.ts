/**
 * One ACP session bound to one engine session (ADR 0001, Decisions 2 and 4).
 *
 * The unit of work is a **run**: one `session/prompt`. A run does not end when a
 * turn ends — the engine keeps launching turns for the same request (a goal
 * continuation, a finished background task), and those belong to the run. It
 * ends at quiescence: `loop.idle`, a session status of `idle`, or a short grace
 * window with no further turn. That is what makes goal and swarm workable, and
 * what keeps the client's composing state truthful for the whole run.
 *
 * Every update goes through one ordered outbox; a run's response is only
 * answered after the outbox has drained, so the client never sees the answer
 * before the text and tool cards that produced it.
 */
import { randomUUID } from 'node:crypto';

import type { SessionNotification, StopReason, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { Event, Session as KimiSession } from '@moonshot-ai/kimi-code-sdk';

import { TextCoalescer } from './coalesce';
import { log } from './log';
import { Outbox } from './outbox';
import { ToolCalls } from './tool-calls';

/** How long a run waits for a continuation turn before it settles. */
const QUIESCE_GRACE_MS = 2_000;

interface Run {
  readonly resolve: (reason: StopReason) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
  /** At least one turn of this run has ended, so quiescence can be honoured. */
  sawTurnEnd: boolean;
  grace: ReturnType<typeof setTimeout> | undefined;
}

export interface SessionBridgeOptions {
  readonly sessionId: string;
  readonly session: KimiSession;
  /** `_meta.terminal_output` is rendered by this client. */
  readonly shadowTerminals: boolean;
  readonly send: (notification: SessionNotification) => Promise<void> | void;
}

export class SessionBridge {
  private readonly outbox: Outbox;
  private readonly assistant: TextCoalescer;
  private readonly thought: TextCoalescer;
  private readonly toolCalls: ToolCalls;
  private readonly unsubscribe: () => void;
  private run: Run | undefined;
  private messageId: string | undefined;

  constructor(private readonly options: SessionBridgeOptions) {
    this.outbox = new Outbox((notification) => options.send(notification as SessionNotification));
    this.assistant = new TextCoalescer((text) => this.emitText('agent_message_chunk', text));
    this.thought = new TextCoalescer((text) => this.emitText('agent_thought_chunk', text));
    this.toolCalls = new ToolCalls({
      sessionId: options.sessionId,
      cwd: () => options.session.workDir,
      shadowTerminals: options.shadowTerminals,
      emit: (notification) => {
        void this.outbox.push(notification);
      },
    });
    this.unsubscribe = options.session.onEvent((event) => {
      this.handleEvent(event);
    });
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  /** The card for a tool call awaiting approval, when it is one we already streamed. */
  pendingCall(toolCallId: string | undefined): ToolCallUpdate | undefined {
    return toolCallId === undefined ? undefined : this.toolCalls.pendingCall(toolCallId);
  }

  /**
   * Submit one prompt and resolve when its run settles.
   *
   * The engine acknowledges the submission before the run is over, so the
   * response comes from the events below, not from `prompt()` itself.
   */
  prompt(text: string): Promise<StopReason> {
    if (this.run !== undefined && !this.run.settled) {
      return Promise.reject(new Error('a run is already in progress in this session'));
    }
    return new Promise<StopReason>((resolve, reject) => {
      const run: Run = { resolve, reject, settled: false, sawTurnEnd: false, grace: undefined };
      this.run = run;
      this.options.session.prompt(text).catch((error: unknown) => {
        this.fail(run, error);
      });
    });
  }

  /** Ask the engine to stop the run. The turn's `cancelled` outcome settles it. */
  cancel(): void {
    void this.options.session.cancel().catch((error: unknown) => {
      log.warn('acp: cancel failed', { sessionId: this.sessionId, error: describe(error) });
    });
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    this.toolCalls.dispose();
    this.assistant.flushNow();
    this.thought.flushNow();
    await this.outbox.drain();
    const run = this.run;
    if (run !== undefined && !run.settled) this.settle(run, 'cancelled');
  }

  private handleEvent(event: Event): void {
    switch (event.type) {
      case 'turn.started': {
        // A continuation turn proves the run is not finished after all.
        this.clearGrace();
        this.messageId = undefined;
        return;
      }
      case 'assistant.delta': {
        this.assistant.push(event.delta);
        return;
      }
      case 'thinking.delta': {
        this.thought.push(event.delta);
        return;
      }
      case 'tool.call.started': {
        this.toolCalls.started(event);
        return;
      }
      case 'tool.call.delta': {
        this.toolCalls.delta(event);
        return;
      }
      case 'tool.updated': {
        this.toolCalls.updated(event);
        return;
      }
      case 'tool.result': {
        this.toolCalls.result(event);
        return;
      }
      case 'turn.ended': {
        this.assistant.flushNow();
        this.thought.flushNow();
        this.messageId = undefined;
        const run = this.run;
        if (run === undefined || run.settled) {
          // A turn nobody prompted: M2 announces it, M0 logs it.
          log.info('acp: turn without a run', { sessionId: this.sessionId, turnId: event.turnId, reason: event.reason });
          return;
        }
        if (event.reason === 'cancelled') {
          this.settle(run, 'cancelled');
          return;
        }
        if (event.reason === 'failed') {
          this.settle(run, 'end_turn');
          return;
        }
        run.sawTurnEnd = true;
        this.armGrace(run);
        return;
      }
      case 'loop.idle': {
        const run = this.run;
        if (run !== undefined && !run.settled && run.sawTurnEnd) this.settle(run, 'end_turn');
        return;
      }
      case 'event.session.status_changed': {
        const run = this.run;
        if (event.status === 'idle' && run !== undefined && !run.settled && run.sawTurnEnd) {
          this.settle(run, 'end_turn');
        }
        return;
      }
      default:
        return;
    }
  }

  private armGrace(run: Run): void {
    if (run.grace !== undefined) return;
    run.grace = setTimeout(() => {
      run.grace = undefined;
      this.settle(run, 'end_turn');
    }, QUIESCE_GRACE_MS);
    run.grace.unref?.();
  }

  private clearGrace(): void {
    const run = this.run;
    if (run?.grace === undefined) return;
    clearTimeout(run.grace);
    run.grace = undefined;
  }

  /**
   * Retire the run exactly once. The response waits for the outbox so the
   * client renders the turns' output before the prompt looks answered.
   */
  private settle(run: Run, reason: StopReason): void {
    if (run.settled) return;
    run.settled = true;
    if (run.grace !== undefined) {
      clearTimeout(run.grace);
      run.grace = undefined;
    }
    if (this.run === run) this.run = undefined;
    this.assistant.flushNow();
    this.thought.flushNow();
    void this.outbox.drain().then(() => {
      run.resolve(reason);
    });
  }

  private fail(run: Run, error: unknown): void {
    if (run.settled) return;
    run.settled = true;
    if (run.grace !== undefined) {
      clearTimeout(run.grace);
      run.grace = undefined;
    }
    if (this.run === run) this.run = undefined;
    this.assistant.flushNow();
    this.thought.flushNow();
    void this.outbox.drain().then(() => {
      run.reject(error);
    });
  }

  private emitText(kind: 'agent_message_chunk' | 'agent_thought_chunk', text: string): void {
    this.messageId ??= randomUUID();
    void this.outbox.push({
      sessionId: this.options.sessionId,
      update: { sessionUpdate: kind, content: { type: 'text', text }, messageId: this.messageId },
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
