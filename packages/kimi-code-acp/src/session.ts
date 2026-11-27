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
  compactionUpdate,
  structuredNotice,
  goalCard,
  goalChange,
  goalCleared,
  notice,
  planNotification,
  subagentAnnouncement,
  subagentCard,
  subagentSessionId,
  subagentUpdate,
  type GoalSnapshotLike,
  type SubagentSpawnedLike,
} from './activity';
import { TextCoalescer } from './coalesce';
import { describeEngineTurn } from './engine-turn';
import { log } from './log';
import { Outbox } from './outbox';
import { airMeta } from './air-extension';
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
  /** The client renders `compaction_update` (`session.compaction`). */
  readonly compaction?: boolean;
  /** The client is JetBrains AIR and takes the `jetbrains.air` payloads. */
  readonly air?: boolean;
  /** The client declared `subagents`: it gets `subagent_update` and child traffic. */
  readonly subagents?: boolean;
  /** The session's working directory, reported for a child that inherits it. */
  readonly cwd?: string;
  readonly send: (notification: SessionNotification) => Promise<void> | void;
}

export class SessionBridge {
  private readonly outbox: Outbox;
  private readonly assistant: TextCoalescer;
  private readonly thought: TextCoalescer;
  private readonly toolCalls: ToolCalls;
  private readonly unsubscribe: () => void;
  private run: Run | undefined;
  /** Runs for prompts steered behind the running turn, in submission order. */
  private readonly queuedRuns: Run[] = [];
  /** The last turn id the engine reported, for `predictNextPrompt`. */
  private lastTurnId: number | undefined;
  /** User message ids in order, for cursor announcements and rewind. */
  private readonly userMessageIds: string[] = [];
  /** The last entity the client holds, for anchoring live cursors. */
  private lastEntity: CursorEntity | undefined;
  /** Message ids of child agents' streams, by agent id (reset per child turn). */
  private readonly childMessageIds = new Map<string, string>();
  /** Whether a plan was shown, so clearing it is reported (an empty `plan`). */
  private planShown = false;
  /** The compaction on screen, for `compaction_update` lifecycle pushes. */
  private compactionId: string | undefined;
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

  /** True while a run owns the session, or a steered prompt awaits its turn. */
  isBusy(): boolean {
    return (
      (this.run !== undefined && !this.run.settled) ||
      this.queuedRuns.some((run) => !run.settled)
    );
  }

  /**
   * A prompt that arrives during a run. The engine queues it (`prompt.queued`),
   * ends the running turn at the step boundary and runs this message as the
   * next turn, so the returned promise settles with that follow-up turn's own
   * outcome — the same per-request settlement a queued `session/prompt` has in
   * claude-code-acp.
   */
  steerAsRun(input: string | readonly PromptPart[]): Promise<StopReason> {
    return new Promise<StopReason>((resolve, reject) => {
      const run: Run = { resolve, reject, settled: false };
      this.queuedRuns.push(run);
      this.options.session.steer(input as string | PromptPart[]).catch((error: unknown) => {
        const index = this.queuedRuns.indexOf(run);
        if (index !== -1) this.queuedRuns.splice(index, 1);
        this.fail(run, error);
      });
    });
  }

  /** Hand the session to the first steered prompt once no run owns it. */
  private promoteQueued(): void {
    if (this.run !== undefined && !this.run.settled) return;
    const next = this.queuedRuns.shift();
    if (next === undefined || next.settled) return;
    this.run = next;
  }

  /** Inject a message into the running turn (ACP `_session/steering`). */
  async steer(parts: readonly PromptPart[]): Promise<void> {
    await this.options.session.steer(parts as PromptPart[]);
  }

  /** Publish the session title/updatedAt (the ACP session index metadata). */
  async publishSessionInfo(title?: string, updatedAt?: string): Promise<void> {
    const info: Record<string, unknown> = {
      sessionUpdate: 'session_info_update',
      ...(title === undefined ? {} : { title }),
      updatedAt: updatedAt ?? new Date().toISOString(),
    };
    await this.post({ sessionId: this.options.sessionId, update: info } as never);
  }

  /** Publish the AIR goal payload (the client renders its goal panel from it). */
  async publishAirGoal(goal: unknown): Promise<void> {
    if (this.options.air !== true) return;
    await this.post({
      sessionId: this.options.sessionId,
      update: {
        sessionUpdate: 'session_info_update',
        _meta: airMeta({ goal }),
      },
    });
  }

  /** Record a user message and announce a rewind cursor for it. */
  /**
   * Record a user message the engine can undo to. Every anchor is recorded;
   * the cursor is announced only where the client holds an entity to anchor it
   * to (replayed messages anchor before themselves, live ones after the
   * previous entity — the first live prompt has neither and gets no cursor).
   */
  trackUserMessage(messageId: string, options: { anchor?: CursorEntity; announce: boolean }): void {
    if (messageId.length === 0 || this.userMessageIds.includes(messageId)) return;
    this.userMessageIds.push(messageId);
    if (!options.announce || this.options.cursors !== true || this.disposed) return;
    void this.post(
      options.anchor === undefined
        ? cursorUpdate(this.options.sessionId, messageId)
        : liveCursorUpdate(this.options.sessionId, messageId, options.anchor),
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
    for (const queued of this.queuedRuns.splice(0)) {
      if (!queued.settled) this.settle(queued, 'cancelled');
    }
  }

  private handleEvent(event: Event): void {
    if (process.env['KIMI_ACP_EVENTS'] === '1') {
      log.info('acp: engine event', {
        type: event.type,
        agentId: (event as { agentId?: unknown }).agentId,
      });
    }
    // The engine runs subagents in the same session: their lifecycle events
    // are session-level, their live traffic carries the child's agent id.
    if ((event.type as string).startsWith('subagent.')) {
      this.handleSubagentEvent(event);
      return;
    }
    const agentId = (event as { agentId?: unknown }).agentId;
    if (typeof agentId === 'string' && agentId !== 'main') {
      this.handleChildEvent(agentId, event);
      return;
    }
    // `turn.prompt` names the engine prompt that just started; the SDK's Event
    // union does not list it, but the engine emits it (and it carries the id a
    // cursor needs).
    if ((event.type as string) === 'turn.prompt') {
      // A turn the engine starts for a steered prompt belongs to that prompt's run.
      this.promoteQueued();
      const prompt = event as unknown as {
        readonly origin?: { readonly kind?: string; readonly trigger?: string };
        readonly trigger?: string;
        readonly promptId?: string;
      };
      // The same prompts the engine counts as undo anchors (its turnUndo.ts),
      // so a rewind drops exactly what the client was shown a cursor for.
      if (isUndoAnchor(prompt.origin, prompt.trigger)) {
        this.trackUserMessage(prompt.promptId ?? randomUUID(), {
          anchor: this.lastEntity,
          announce: this.lastEntity !== undefined,
        });
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
          const plan = planNotification(
            this.options.sessionId,
            event.display.items,
            this.planShown,
          );
          if (plan !== null) {
            this.planShown = event.display.items.length > 0;
            void this.outbox.push(plan);
          }
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
        // The engine runs a steered message as the turn after this one.
        this.promoteQueued();
        return;
      }
      case 'prompt.submitted': {
        // Only a prompt the user typed gets a rewind cursor.
        const origin = event.origin as { readonly kind?: string } | undefined;
        if ((origin === undefined || origin.kind === 'user') && typeof event.userMessageId === 'string') {
          this.trackUserMessage(event.userMessageId, { announce: false });
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
          void this.publishAirGoal(null);
          return;
        }
        void this.publishAirGoal(snapshot);
        if (this.goalId === snapshot.goalId) {
          void this.outbox.push(goalChange(this.options.sessionId, snapshot));
        } else {
          void this.outbox.push(goalCard(this.options.sessionId, snapshot));
          this.goalId = snapshot.goalId;
        }
        return;
      }
      case 'compaction.started': {
        const instruction = event.instruction;
        if (this.options.compaction === true) {
          this.compactionId = randomUUID();
          void this.outbox.push(
            compactionUpdate(this.options.sessionId, this.compactionId, 'in_progress'),
          );
          return;
        }
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
        if (this.options.compaction === true && this.compactionId !== undefined) {
          void this.outbox.push(
            compactionUpdate(this.options.sessionId, this.compactionId, 'completed', lines.join('\n')),
          );
          return;
        }
        void this.outbox.push(notice(this.options.sessionId, lines.join('\n')));
        return;
      }
      case 'compaction.cancelled': {
        if (this.options.compaction === true && this.compactionId !== undefined) {
          void this.outbox.push(
            compactionUpdate(this.options.sessionId, this.compactionId, 'cancelled'),
          );
          this.compactionId = undefined;
          return;
        }
        void this.outbox.push(notice(this.options.sessionId, 'Compaction cancelled.'));
        return;
      }
      case 'compaction.blocked': {
        const blocked =
          'Compaction is blocked by the current turn; retry when the turn is idle.';
        if (this.options.compaction === true && this.compactionId !== undefined) {
          void this.outbox.push(
            compactionUpdate(this.options.sessionId, this.compactionId, 'failed', blocked),
          );
          this.compactionId = undefined;
          return;
        }
        void this.outbox.push(notice(this.options.sessionId, blocked));
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
          void this.publishSessionInfo(event.title);
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

  /**
   * A subagent lifecycle event: the parent's card always, and for a client
   * that declared `subagents` the ACP `subagent_update` on the parent session
   * (announce on spawn, state patches after).
   */
  private handleSubagentEvent(event: Event): void {
    const parentId = this.options.sessionId;
    const spawned = event as unknown as SubagentSpawnedLike;
    const subagentId = typeof spawned.subagentId === 'string' ? spawned.subagentId : '';
    if (subagentId.length === 0) return;
    const announce = this.options.subagents === true;
    switch (event.type) {
      case 'subagent.spawned': {
        void this.outbox.push(subagentCard(parentId, spawned));
        if (announce) {
          void this.outbox.push(
            subagentAnnouncement(parentId, subagentId, {
              title: spawned.subagentName,
              ...(spawned.description === undefined ? {} : { description: spawned.description }),
              ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
              state: { state: 'running' },
            }),
          );
        }
        return;
      }
      case 'subagent.started': {
        void this.outbox.push(subagentUpdate(parentId, subagentId, 'in_progress', undefined));
        if (announce) {
          void this.outbox.push(subagentAnnouncement(parentId, subagentId, { state: { state: 'running' } }));
        }
        return;
      }
      case 'subagent.completed': {
        const summary = event.resultSummary;
        void this.outbox.push(
          subagentUpdate(parentId, subagentId, 'completed', summary.length > 0 ? summary : 'Subagent finished.'),
        );
        if (announce) {
          void this.outbox.push(
            subagentAnnouncement(parentId, subagentId, { state: { state: 'idle', stopReason: 'end_turn' } }),
          );
        }
        return;
      }
      case 'subagent.failed': {
        void this.outbox.push(subagentUpdate(parentId, subagentId, 'failed', event.error));
        if (announce) {
          void this.outbox.push(subagentAnnouncement(parentId, subagentId, { state: { state: 'idle' } }));
        }
        return;
      }
      case 'subagent.cancelled': {
        void this.outbox.push(subagentUpdate(parentId, subagentId, 'failed', 'Subagent cancelled.'));
        if (announce) {
          void this.outbox.push(
            subagentAnnouncement(parentId, subagentId, { state: { state: 'idle', stopReason: 'cancelled' } }),
          );
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * A child agent's live event. It never touches the parent's run: a child's
   * `turn.ended` is not the parent's, and its text is not the parent's message.
   * For a client that declared `subagents`, text streams on the child's session.
   */
  private handleChildEvent(agentId: string, event: Event): void {
    if (this.options.subagents !== true) return;
    const childSessionId = subagentSessionId(this.options.sessionId, agentId);
    const messageId = (() => {
      const existing = this.childMessageIds.get(agentId);
      if (existing !== undefined) return existing;
      const created = `${childSessionId}:${randomUUID()}`;
      this.childMessageIds.set(agentId, created);
      return created;
    })();
    if (event.type === 'turn.started') {
      this.childMessageIds.delete(agentId);
      return;
    }
    if (event.type === 'turn.ended' || (event.type as string) === 'turn.prompt') return;
    const text = (event as { delta?: unknown }).delta;
    if (typeof text !== 'string' || text.length === 0) return;
    const kind = event.type === 'assistant.delta' ? 'agent_message_chunk' : event.type === 'thinking.delta' ? 'agent_thought_chunk' : undefined;
    if (kind === undefined) return;
    void this.outbox.push({
      sessionId: childSessionId,
      update: { sessionUpdate: kind, content: { type: 'text', text }, messageId },
    } as SessionNotification);
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

/** Whether the engine counts a prompt as an undo anchor (`turnUndo.ts`). */
function isUndoAnchor(
  origin: { readonly kind?: string; readonly trigger?: string } | undefined,
  trigger: string | undefined,
): boolean {
  if (trigger === 'continue') return false;
  if (origin === undefined || origin.kind === 'user') return true;
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}