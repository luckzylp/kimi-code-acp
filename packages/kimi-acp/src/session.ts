/**
 * One ACP session bound to one engine session (ADR 0001, Decisions 2 and 4).
 *
 * The unit of work is a **run**: one `session/prompt`. A run does not end when a
 * turn ends — the engine keeps launching turns for the same request (a goal
 * continuation, a finished background task), and those belong to the run. It
 * ends when the engine ends the turn (2.8 runs a prompt as one turn, with model
 * steps and tool calls as steps inside it), or when the session reports idle. That is what makes goal and swarm workable, and
 * what keeps the client's composing state truthful for the whole run.
 *
 * Every update goes through one ordered outbox; a run's response is only
 * answered after the outbox has drained, so the client never sees the answer
 * before the text and tool cards that produced it.
 */
import { randomUUID } from 'node:crypto';

import type {
  AvailableCommand,
  SessionNotification,
  StopReason,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk/unstable';
import type { Event, PromptPart, Session as KimiSession } from '@moonshot-ai/kimi-code-sdk';

import {
  structuredNotice,
  goalCard,
  goalChange,
  goalCleared,
  notice,
  planNotification,
  subagentCard,
  subagentUpdate,
  type GoalSnapshotLike,
  type SubagentSpawnedLike,
} from './activity';
import { TextCoalescer } from './coalesce';
import { describeEngineTurn } from './engine-turn';
import { log } from './log';
import { Outbox } from './outbox';
import { cursorUpdate, liveCursorUpdate, messageIdOfCursor, type CursorEntity } from './rewind';
import { acpToolCallId, ToolCalls } from './tool-calls';

/** The ACP stop reason for an engine turn end (mirrors the upstream mapping). */
function turnStopReason(
  reason: 'completed' | 'cancelled' | 'failed' | 'blocked',
  error: { readonly code?: string } | undefined,
): StopReason {
  switch (reason) {
    case 'completed':
      return 'end_turn';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return error?.code === 'provider.filtered' ? 'refusal' : 'end_turn';
    case 'blocked':
      return 'refusal';
  }
}

interface Run {
  readonly resolve: (reason: StopReason) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
}

export interface SessionBridgeOptions {
  readonly sessionId: string;
  readonly session: KimiSession;
  /** `_meta.terminal_output` is rendered by this client. */
  readonly shadowTerminals: boolean;
  /** The client appends `_meta.terminal_output_delta` chunks itself. */
  readonly terminalOutputDelta?: boolean;
  /** The client renders a predicted next prompt (`session.promptSuggestions`). */
  readonly promptSuggestions?: boolean;
  /** The client accepts `cursor_update` and may rewind (`session.cursors`). */
  readonly cursors?: boolean;
  /** The client renders structured notices (`session.notices`). */
  readonly notices?: boolean;
  readonly send: (notification: SessionNotification) => Promise<void> | void;
}

export class SessionBridge {
  private readonly outbox: Outbox;
  private readonly assistant: TextCoalescer;
  private readonly thought: TextCoalescer;
  private readonly toolCalls: ToolCalls;
  private readonly unsubscribe: () => void;
  private run: Run | undefined;
  /** The last turn id the engine reported, for `predictNextPrompt`. */
  private lastTurnId: number | undefined;
  /** User message ids in order, for cursor announcements and rewind. */
  private readonly userMessageIds: string[] = [];
  /** The last entity the client holds, for anchoring live cursors. */
  private lastEntity: CursorEntity | undefined;
  private disposed = false;
  private messageId: string | undefined;
  /** The goal currently on screen, so changes update its card instead of adding one. */
  private goalId: string | undefined;

  constructor(private readonly options: SessionBridgeOptions) {
    this.outbox = new Outbox((notification) => options.send(notification as SessionNotification));
    this.assistant = new TextCoalescer((text) => this.emitText('agent_message_chunk', text));
    this.thought = new TextCoalescer((text) => this.emitText('agent_thought_chunk', text));
    this.toolCalls = new ToolCalls({
      sessionId: options.sessionId,
      cwd: () => options.session.workDir,
      shadowTerminals: options.shadowTerminals,
      terminalOutputDelta: options.terminalOutputDelta === true,
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

  /** Post one notification through the ordered outbox (used by `session/load` replay). */
  post(notification: SessionNotification): Promise<void> {
    // A client may close right after a response; late pushes are dropped rather
    // than surfacing "Session is closed" in the transcript.
    if (this.disposed) return Promise.resolve();
    return this.outbox.push(notification);
  }

  /** True while a run owns the session (a prompt is in flight). */
  isBusy(): boolean {
    return this.run !== undefined && !this.run.settled;
  }

  /** Inject a message into the running turn (ACP `_session/steering`). */
  async steer(parts: readonly PromptPart[]): Promise<void> {
    await this.options.session.steer(parts as PromptPart[]);
  }

  /** Record a user message and announce a rewind cursor for it. */
  trackUserMessage(messageId: string, anchor?: CursorEntity): void {
    if (messageId.length === 0 || this.userMessageIds.includes(messageId)) return;
    this.userMessageIds.push(messageId);
    if (this.options.cursors !== true || this.disposed) return;
    void this.post(
      anchor === undefined
        ? cursorUpdate(this.options.sessionId, messageId)
        : liveCursorUpdate(this.options.sessionId, messageId, anchor),
    );
  }

  /** The index of the user message a cursor lies before, if it names one. */
  rewindIndex(cursorId: string): number | undefined {
    const messageId = messageIdOfCursor(cursorId);
    if (messageId === undefined) return undefined;
    const index = this.userMessageIds.indexOf(messageId);
    return index === -1 ? undefined : index;
  }

  userMessageCount(): number {
    return this.userMessageIds.length;
  }

  /** Forget the messages from `index` on after they were undone. */
  truncateUserMessages(index: number): void {
    this.userMessageIds.length = Math.max(0, index);
  }

  /** The goal whose card is currently on screen, if any. */
  currentGoalId(): string | undefined {
    return this.goalId;
  }

  /** Close a goal's card; used when the goal is cleared without a `goal.updated`. */
  async clearGoalCard(goalId: string, reason: string): Promise<void> {
    await this.post(goalCleared(this.options.sessionId, goalId, reason));
    if (this.goalId === goalId) this.goalId = undefined;
  }

  /** Report a system event: a structured notice when supported, else a message. */
  async notify(
    severity: 'info' | 'warning' | 'error',
    title: string,
    description?: string,
  ): Promise<void> {
    if (this.options.notices === true) {
      await this.post(structuredNotice(this.options.sessionId, severity, title, description));
      return;
    }
    await this.note(description === undefined ? title : `${title}: ${description}`);
  }

  /** Write a one-line system message into the transcript. */
  async note(text: string): Promise<void> {
    await this.post(notice(this.options.sessionId, text));
  }

  /** Resolve once every queued update has been written. */
  async flush(): Promise<void> {
    this.assistant.flushNow();
    this.thought.flushNow();
    await this.outbox.drain();
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
  prompt(
    input: string | readonly PromptPart[],
    skill?: { readonly name: string; readonly args?: string },
  ): Promise<StopReason> {
    if (this.run !== undefined && !this.run.settled) {
      return Promise.reject(new Error('a run is already in progress in this session'));
    }
    return new Promise<StopReason>((resolve, reject) => {
      const run: Run = { resolve, reject, settled: false };
      this.run = run;
      const submission =
        skill === undefined
          ? this.options.session.prompt(input as string | PromptPart[])
          : this.options.session.promptWithSkills(input as string | PromptPart[], [skill]);
      submission.catch((error: unknown) => {
        this.fail(run, error);
      });
    });
  }

  /** Push `usage_update` from the engine's live context counters. */
  async emitUsage(): Promise<void> {
    if (this.disposed) return;
    try {
      const status = await this.options.session.getStatus();
      if (status.maxContextTokens <= 0) return;
      await this.post({
        sessionId: this.options.sessionId,
        update: {
          sessionUpdate: 'usage_update',
          used: status.contextTokens,
          size: status.maxContextTokens,
        },
      });
    } catch (error) {
      log.warn('acp: failed to push usage_update', { sessionId: this.sessionId, error: describe(error) });
    }
  }

  /** Advertise the session's skills as slash commands. */
  async emitCommands(commands: readonly AvailableCommand[]): Promise<void> {
    if (this.disposed) return;
    try {
      await this.post({
        sessionId: this.options.sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [...commands],
        },
      });
    } catch (error) {
      log.warn('acp: failed to push available_commands_update', {
        sessionId: this.sessionId,
        error: describe(error),
      });
    }
  }

  /** Ask the engine to stop the run. The turn's `cancelled` outcome settles it. */
  cancel(): void {
    void this.options.session.cancel().catch((error: unknown) => {
      log.warn('acp: cancel failed', { sessionId: this.sessionId, error: describe(error) });
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe();
    this.toolCalls.dispose();
    this.assistant.flushNow();
    this.thought.flushNow();
    await this.outbox.drain();
    const run = this.run;
    if (run !== undefined && !run.settled) this.settle(run, 'cancelled');
  }

  private handleEvent(event: Event): void {
    if (process.env['KIMI_ACP_EVENTS'] === '1') log.info('acp: engine event', { type: event.type });
    // `turn.prompt` names the engine prompt that just started; the SDK's Event
    // union does not list it, but the engine emits it (and it carries the id a
    // cursor needs).
    if ((event.type as string) === 'turn.prompt') {
      const prompt = event as unknown as {
        readonly origin?: { readonly kind?: string };
        readonly promptId?: string;
      };
      if ((prompt.origin === undefined || prompt.origin.kind === 'user') && this.lastEntity !== undefined) {
        this.trackUserMessage(prompt.promptId ?? randomUUID(), this.lastEntity);
      }
      return;
    }
    switch (event.type) {
      case 'turn.started': {
        this.messageId = undefined;
        if (this.run === undefined || this.run.settled) {
          // Nobody prompted this turn: say what set the agent off (Decision 2.4).
          // A turn inside a run is continuation bookkeeping and stays silent.
          const note = describeEngineTurn(event.origin, event.prompt);
          if (note !== undefined) {
            void this.outbox.push({
              sessionId: this.options.sessionId,
              update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: note } },
            });
          }
        }
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
        if (event.display?.kind === 'todo_list') {
          const plan = planNotification(this.options.sessionId, event.display.items);
          if (plan !== null) void this.outbox.push(plan);
        }
        this.toolCalls.started(event);
        this.lastEntity = { type: 'tool_call', toolCallId: acpToolCallId(event.turnId, event.toolCallId) };
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
        this.lastTurnId = event.turnId;
        this.assistant.flushNow();
        this.thought.flushNow();
        this.messageId = undefined;
        const run = this.run;
        if (run === undefined || run.settled) {
          // A turn nobody prompted: M2 announces it, M0 logs it.
          log.info('acp: turn without a run', { sessionId: this.sessionId, turnId: event.turnId, reason: event.reason });
          return;
        }
        // Engine 2.8 runs a prompt as one turn (model steps and tool calls are
        // steps inside it), so the turn's end is the run's end — the same
        // settlement the upstream ACP server uses.
        this.settle(run, turnStopReason(event.reason, event.error));
        return;
      }
      case 'prompt.submitted': {
        // Only a prompt the user typed gets a rewind cursor.
        const origin = event.origin as { readonly kind?: string } | undefined;
        if ((origin === undefined || origin.kind === 'user') && typeof event.userMessageId === 'string') {
          this.trackUserMessage(event.userMessageId);
        }
        return;
      }
      case 'prompt.steered': {
        return;
      }
      case 'prompt.completed': {
        // Some engine paths report the prompt itself instead of a turn end.
        const run = this.run;
        if (run === undefined || run.settled) return;
        this.settle(run, turnStopReason(event.reason ?? 'completed', undefined));
        return;
      }
      case 'prompt.aborted': {
        const run = this.run;
        if (run !== undefined && !run.settled) this.settle(run, 'cancelled');
        return;
      }
      case 'goal.updated': {
        const snapshot = event.snapshot as GoalSnapshotLike | null | undefined;
        if (snapshot === null || snapshot === undefined) {
          if (this.goalId !== undefined) {
            void this.outbox.push(goalCleared(this.options.sessionId, this.goalId, 'Goal cleared.'));
            this.goalId = undefined;
          }
          return;
        }
        if (this.goalId === snapshot.goalId) {
          void this.outbox.push(goalChange(this.options.sessionId, snapshot));
        } else {
          void this.outbox.push(goalCard(this.options.sessionId, snapshot));
          this.goalId = snapshot.goalId;
        }
        return;
      }
      case 'subagent.spawned': {
        void this.outbox.push(subagentCard(this.options.sessionId, event as unknown as SubagentSpawnedLike));
        return;
      }
      case 'subagent.started': {
        void this.outbox.push(subagentUpdate(this.options.sessionId, event.subagentId, 'in_progress', undefined));
        return;
      }
      case 'subagent.completed': {
        void this.outbox.push(
          subagentUpdate(
            this.options.sessionId,
            event.subagentId,
            'completed',
            event.resultSummary.length > 0 ? event.resultSummary : 'Subagent finished.',
          ),
        );
        return;
      }
      case 'subagent.failed': {
        void this.outbox.push(
          subagentUpdate(this.options.sessionId, event.subagentId, 'failed', event.error),
        );
        return;
      }
      case 'subagent.cancelled': {
        void this.outbox.push(
          subagentUpdate(this.options.sessionId, event.subagentId, 'failed', 'Subagent cancelled.'),
        );
        return;
      }
      case 'compaction.started': {
        const instruction = event.instruction;
        void this.outbox.push(
          notice(
            this.options.sessionId,
            instruction === undefined || instruction.length === 0
              ? 'Compacting conversation context…'
              : `Compacting conversation context with instruction: ${instruction}`,
          ),
        );
        return;
      }
      case 'compaction.completed': {
        const result = event.result as
          | { readonly compactedCount?: number; readonly tokensBefore?: number; readonly tokensAfter?: number }
          | undefined;
        const lines = ['Compaction completed.'];
        if (typeof result?.compactedCount === 'number') lines.push(`- Messages compacted: ${String(result.compactedCount)}`);
        if (typeof result?.tokensBefore === 'number') lines.push(`- Tokens before: ${String(result.tokensBefore)}`);
        if (typeof result?.tokensAfter === 'number') lines.push(`- Tokens after: ${String(result.tokensAfter)}`);
        void this.outbox.push(notice(this.options.sessionId, lines.join('\n')));
        return;
      }
      case 'compaction.cancelled': {
        void this.outbox.push(notice(this.options.sessionId, 'Compaction cancelled.'));
        return;
      }
      case 'compaction.blocked': {
        void this.outbox.push(
          notice(this.options.sessionId, 'Compaction is blocked by the current turn; retry when the turn is idle.'),
        );
        return;
      }
      case 'error': {
        // A failed request or provider error is otherwise invisible to the
        // client: the turn ends, but nothing says why.
        log.warn('acp: engine error', { sessionId: this.sessionId, code: event.code, message: event.message });
        void this.notify('error', `[kimi-code] ${event.message}`);
        return;
      }
      case 'warning': {
        void this.notify('warning', `[kimi-code] ${event.message}`);
        return;
      }
      case 'session.meta.updated': {
        if (typeof event.title === 'string' && event.title.length > 0) {
          void this.outbox.push({
            sessionId: this.options.sessionId,
            update: { sessionUpdate: 'session_info_update', title: event.title },
          });
        }
        return;
      }
      case 'event.session.status_changed': {
        const run = this.run;
        if (event.status === 'idle' && run !== undefined && !run.settled) {
          this.settle(run, 'end_turn');
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Retire the run exactly once. The response waits for the outbox so the
   * client renders the turns' output before the prompt looks answered.
   */
  private settle(run: Run, reason: StopReason): void {
    if (run.settled) return;
    run.settled = true;
    if (this.run === run) this.run = undefined;
    this.assistant.flushNow();
    this.thought.flushNow();
    void this.outbox.drain().then(() => {
      run.resolve(reason);
    });
    void this.suggestNextPrompt();
  }

  /**
   * Ask the engine to predict the user's next prompt and publish it as ACP's
   * `prompt_suggestions_update`. Gated on the client capability: a prediction
   * costs one model request per turn.
   */
  private async suggestNextPrompt(): Promise<void> {
    if (this.options.promptSuggestions !== true || this.disposed) return;
    const expectedTurnId = this.lastTurnId;
    if (expectedTurnId === undefined) return;
    try {
      const text = await this.options.session.predictNextPrompt({
        predictionId: randomUUID(),
        expectedTurnId,
      });
      if (this.disposed) return;
      await this.post({
        sessionId: this.options.sessionId,
        update: {
          sessionUpdate: 'prompt_suggestions_update',
          suggestions: text === null ? [] : [{ prompt: [{ type: 'text', text }] }],
        },
      });
    } catch (error) {
      log.warn('acp: prompt prediction failed', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private fail(run: Run, error: unknown): void {
    if (run.settled) return;
    run.settled = true;
    if (this.run === run) this.run = undefined;
    this.assistant.flushNow();
    this.thought.flushNow();
    void this.outbox.drain().then(() => {
      run.reject(error);
    });
  }

  private emitText(kind: 'agent_message_chunk' | 'agent_thought_chunk', text: string): void {
    this.messageId ??= randomUUID();
    if (kind === 'agent_message_chunk') {
      this.lastEntity = { type: 'agent_message', messageId: this.messageId };
    }
    void this.outbox.push({
      sessionId: this.options.sessionId,
      update: { sessionUpdate: kind, content: { type: 'text', text }, messageId: this.messageId },
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}