/**
 * One ACP session bound to one engine session (ADR 0001, Decisions 2 and 4).
 *
 * The unit of work is a **run**: one `session/prompt`. A run does not end when a
 * turn ends — the engine keeps launching turns for the same request (a finished
 * background task, a goal continuation), and those belong to the run. It ends
 * when the engine ends the turn (2.8 runs a prompt as one turn, with model steps
 * and tool calls as steps inside it) **and** nothing the turn started is still
 * running, or when the session reports idle. That is what makes goal and swarm
 * workable, and what keeps the client's composing state truthful for the whole
 * run: a command that outlives its turn is still work the user is waiting on.
 *
 * The one exception is deliberate backgrounding: a tool call that the model
 * launched with `run_in_background` returned control to the user on purpose
 * (a dev server, a watcher), so it does not hold the run open. And the hold
 * itself gives way: a prompt the user steers in while the run waits takes the
 * session (FIFO, one run at a time), so the held run settles with its own
 * turn's outcome and the command's result turn belongs to whoever is live
 * then, or to nobody (an engine turn with its note).
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
  /** The engine's id for the prompt this run owns: how a turn is told apart from an orphan. */
  promptId?: string;
  /** Settled by a cancel that had no turn to end: its turn may still come. */
  cancelled?: boolean;
  /** A goal run: its turns end, the goal keeps going, so the run outlives them. */
  goal?: boolean;
}

/** A run whose turn ended while background work it started still runs. */
interface DeferredSettlement {
  readonly run: Run;
  readonly reason: StopReason;
}

/**
 * How long a settled turn waits for the turn the engine starts to report a
 * finished background task. The engine launches it as soon as the task ends
 * (`turn.prompt` with a `task` origin), so this only covers the scheduling gap;
 * longer and a dropped notification would leave the client composing forever.
 */
const TASK_FOLLOW_UP_GRACE_MS = 1_000;

/** The `session.meta.updated` patch fields that tell a real title from a placeholder. */
interface TitlePatch {
  readonly isCustomTitle?: unknown;
  readonly lastPrompt?: unknown;
}

/**
 * Whether a `session.meta.updated` title is one the client should show.
 *
 * The engine titles a session that has none with its first prompt
 * (`lastPrompt` set, `isCustomTitle: false`) so the TUI's list is never empty.
 * That is a placeholder: publishing it names the thread after the user's first
 * message until the adapter's own title lands, and forever when the model
 * cannot summarize. Only a real title crosses — a custom one (the adapter's
 * rename, the user's `/title`) or a generated one.
 */
export function isPublishableTitle(patch: TitlePatch | undefined, title: string | undefined): boolean {
  if (title === undefined || title.trim().length === 0) return false;
  if (patch === undefined) return true;
  return patch.lastPrompt === undefined || patch.isCustomTitle === true;
}

/**
 * The title a client should show for a stored session summary, if any.
 *
 * The engine titles a session that has none with its first prompt, cut at
 * 200 characters (`titleFromPromptMetadataText`), and keeps that prompt as
 * `lastPrompt`. A live or restored session says so (`titleKind` is
 * `replaceable`); a listed one carries no kind, so the placeholder is
 * recognized by being exactly that cut — a generated title is never the whole
 * first 200 characters of the prompt, and a prefix match would misread short
 * prompts whose title starts with the same words.
 */
export function displayTitle(summary: {
  readonly title?: string | undefined;
  readonly titleKind?: string | undefined;
  readonly lastPrompt?: string | undefined;
} | undefined): string | undefined {
  const title = summary?.title;
  if (typeof title !== 'string' || title.trim().length === 0) return undefined;
  if (summary?.titleKind !== undefined) return summary.titleKind === 'replaceable' ? undefined : title;
  const prompt = summary?.lastPrompt;
  return typeof prompt === 'string' && title === prompt.slice(0, PLACEHOLDER_TITLE_CHARS) ? undefined : title;
}

/** The engine's `MAX_TITLE_LENGTH` for a prompt-derived title. */
const PLACEHOLDER_TITLE_CHARS = 200;

/**
 * How many cancelled prompt ids to keep waiting for. A cancelled prompt's turn
 * starts within moments of the cancel; keeping the last few is ample, and it
 * keeps a session that is cancelled over and over bounded.
 */
const MAX_CANCELLED_PROMPTS = 16;

/** The background-task facts this bridge reads (`background.task.*` payloads). */
interface BackgroundTaskInfoLike {
  readonly taskId?: unknown;
  readonly kind?: unknown;
  readonly parentToolCallId?: unknown;
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
  /** Grace before a finished task's continuation turn is expected (tests shrink it). */
  readonly followUpGraceMs?: number;
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
  /** The compaction on screen, for `compaction_update` lifecycle pushes. */
  private compactionId: string | undefined;
  private disposed = false;
  private messageId: string | undefined;
  /** The goal currently on screen, so changes update its card instead of adding one. */
  private goalId: string | undefined;
  /** Whether a main-agent turn is running, i.e. the run has live work. */
  private turnActive = false;
  /** Background tasks this run started and the client is still waiting on. */
  private readonly heldTasks = new Set<string>();
  /** Tool calls launched with `run_in_background`: the model returned control. */
  private readonly backgroundCalls = new Set<string>();
  /** A turn ended while held tasks run; settle once they are gone. */
  private deferred: DeferredSettlement | undefined;
  private deferredTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Prompt ids of runs cancelled before their turn ran. The engine cannot
   * cancel a prompt with no active turn and keeps going with a queued user
   * prompt after a cancel, so that turn still starts later — as an orphan,
   * since its run was already answered. Recognized by id, it is stopped then.
   */
  private readonly cancelledPrompts = new Set<string>();
  /** A run cancelled before the engine reported its prompt id: one, at most. */
  private cancelledRunAwaitingId: Run | undefined;
  /**
   * Unowned turns that started while a cancelled run's id was still unknown.
   * Any number of them can start in that window (an injected `_session/steering`
   * turn, the cancelled prompt's own); the one whose id matches is the orphan.
   */
  private readonly unownedTurnsAwaitingId = new Set<string>();

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
      // Our own id, so the turn this prompt gets can be told from any other.
      const promptId = randomUUID();
      const run: Run = { resolve, reject, settled: false, promptId };
      this.queuedRuns.push(run);
      this.options.session.steer(input as string | PromptPart[], { promptId }).catch((error: unknown) => {
        const index = this.queuedRuns.indexOf(run);
        if (index !== -1) this.queuedRuns.splice(index, 1);
        this.fail(run, error);
      });
    });
  }

  /**
   * The engine accepted a run's prompt and named it. A run cancelled while the
   * submission was still in flight could not record that then: do it now, and
   * stop the orphan turn if it has already started.
   */
  private bindPromptId(run: Run, promptId: string): void {
    run.promptId = promptId;
    // A run that merely finished before its submission came back is not an
    // orphan: its turn already ran (or is running) and belongs to nobody.
    if (!run.settled || run.cancelled !== true) return;
    if (this.cancelledRunAwaitingId === run) this.cancelledRunAwaitingId = undefined;
    this.rememberCancelledPrompt(promptId);
    const wasUnowned = this.unownedTurnsAwaitingId.delete(promptId);
    // The id is known now, so no turn starting from here can belong to it.
    this.unownedTurnsAwaitingId.clear();
    if (wasUnowned) this.stopOrphanTurn();
  }

  /** Settle the run holding this session for a goal, if there is one. */
  private settleGoalRun(reason: StopReason): void {
    const run = this.run;
    if (run !== undefined && run.goal === true && !run.settled) this.settle(run, reason);
  }

  /** A cancelled run's turn started after all: stop it, unless a live run owns the session. */
  private stopOrphanTurn(): void {
    if (this.run !== undefined && !this.run.settled) return;
    void this.options.session.cancel().catch((error: unknown) => {
      log.warn('acp: cancel failed', { sessionId: this.sessionId, error: describe(error) });
    });
  }

  /** Whether a steered prompt is still waiting for its turn. */
  private hasQueuedRun(): boolean {
    return this.queuedRuns.some((run) => !run.settled);
  }

  /**
   * A run held for background work steps aside for a steered prompt: the
   * engine runs that prompt as the next turn, and the turn must be its own.
   * The held run settles with the outcome of the turn it did have.
   */
  private yieldHoldToQueued(originKind: string | undefined): void {
    if (originKind !== undefined && originKind !== 'user') return;
    const deferred = this.deferred;
    if (deferred === undefined || !this.hasQueuedRun()) return;
    this.settle(deferred.run, deferred.reason);
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
    options: { readonly goal?: boolean } = {},
  ): Promise<StopReason> {
    if (this.run !== undefined && !this.run.settled) {
      return Promise.reject(new Error('a run is already in progress in this session'));
    }
    return new Promise<StopReason>((resolve, reject) => {
      const run: Run = { resolve, reject, settled: false, ...(options.goal === true ? { goal: true } : {}) };
      this.run = run;
      const submission =
        skill === undefined
          ? this.options.session.prompt(input as string | PromptPart[])
          : this.options.session.promptWithSkills(input as string | PromptPart[], [skill]);
      submission.then(
        (accepted) => {
          if (typeof accepted?.promptId === 'string') this.bindPromptId(run, accepted.promptId);
        },
        (error: unknown) => {
          this.fail(run, error);
        },
      );
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

  /**
   * Ask the engine to stop the run. The turn's `cancelled` outcome settles it;
   * a run that is only waiting on its own background work has no turn left to
   * cancel, so it stops the tasks it is waiting on and settles here.
   */
  cancel(): void {
    // A goal keeps relaunching continuations: cancel means stop it, not just
    // its current turn (ADR 0001, Decision 2, rule 7).
    if (this.run?.goal === true && !this.run.settled) {
      void this.options.session.pauseGoal().catch((error: unknown) => {
        log.warn('acp: failed to pause the goal', { sessionId: this.sessionId, error: describe(error) });
      });
    }
    void this.options.session.cancel().catch((error: unknown) => {
      log.warn('acp: cancel failed', { sessionId: this.sessionId, error: describe(error) });
    });
    for (const taskId of this.heldTasks) this.stopTask(taskId);
    this.heldTasks.clear();
    const deferred = this.deferred;
    this.clearDeferred();
    if (deferred !== undefined && !deferred.run.settled) this.settle(deferred.run, 'cancelled');
    // A cancel every live turn answers itself (`turn.ended` cancelled). A run
    // with no turn behind it has no such event: one waiting for the steered
    // turn the engine just cancelled, or a prompt still being submitted. Left
    // alone it would hold its `session/prompt` open forever, so the client's
    // composer stays busy and the session looks stopped. Settle those here.
    const run = this.run;
    if (run !== undefined && !run.settled && !this.turnActive) {
      this.rememberCancelled(run);
      this.settle(run, 'cancelled');
    }
    for (const queued of this.queuedRuns.splice(0)) {
      if (queued.settled) continue;
      this.rememberCancelled(queued);
      this.settle(queued, 'cancelled');
    }
  }

  /** Remember a run the cancel answers without a turn, so that turn is stopped when it starts. */
  private rememberCancelled(run: Run): void {
    run.cancelled = true;
    if (run.promptId === undefined) {
      this.cancelledRunAwaitingId = run;
      return;
    }
    this.rememberCancelledPrompt(run.promptId);
  }

  /**
   * Keep a cancelled prompt id until its turn starts. The wait is short, so the
   * set is capped: a session cancelled over and over without its turns ever
   * starting must not grow it without bound.
   */
  private rememberCancelledPrompt(promptId: string): void {
    this.cancelledPrompts.add(promptId);
    while (this.cancelledPrompts.size > MAX_CANCELLED_PROMPTS) {
      const oldest = this.cancelledPrompts.values().next().value;
      if (oldest === undefined) return;
      this.cancelledPrompts.delete(oldest);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe();
    this.toolCalls.dispose();
    this.assistant.flushNow();
    this.thought.flushNow();
    await this.outbox.drain();
    this.clearDeferred();
    this.heldTasks.clear();
    this.cancelledPrompts.clear();
    this.cancelledRunAwaitingId = undefined;
    this.unownedTurnsAwaitingId.clear();
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
    // Background tasks outlive the tool call that started them, so they are
    // read before the child-agent routing drops non-text child events.
    if ((event.type as string).startsWith('background.task.')) {
      this.handleBackgroundTask(event);
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
      const prompt = event as unknown as {
        readonly origin?: { readonly kind?: string; readonly trigger?: string };
        readonly trigger?: string;
        readonly promptId?: string;
      };
      // A turn the engine starts for a steered prompt belongs to that prompt's
      // run; a run still held for background work steps aside for it.
      this.yieldHoldToQueued(prompt.origin?.kind);
      this.promoteQueued();
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
        this.turnActive = true;
        // A turn that started after a task ended owns the next stretch of work;
        // the grace timer must not settle the run behind its back.
        this.cancelDeferredTimer();
        // A turn nobody owns, for a prompt whose run the cancel already
        // answered: the engine could not stop it (no active turn at the time,
        // or a queued user prompt it keeps for after the cancel), so stop it now.
        // One whose run's id is not known yet is decided when the id arrives.
        if (this.run === undefined || this.run.settled) {
          const promptId = (event as { readonly promptId?: unknown }).promptId;
          if (typeof promptId === 'string' && this.cancelledPrompts.has(promptId)) {
            this.cancelledPrompts.delete(promptId);
            // Its id is known, so no turn starting from here belongs to it.
            this.unownedTurnsAwaitingId.clear();
            this.stopOrphanTurn();
          } else if (typeof promptId === 'string' && this.cancelledRunAwaitingId !== undefined) {
            this.unownedTurnsAwaitingId.add(promptId);
          }
        }
        this.messageId = undefined;
        if (this.run === undefined || this.run.settled) {
          // Nobody prompted this turn: say what set the agent off (Decision 2, rule 2).
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
        // `run_in_background` is the model handing the client back its turn
        // (a servers/watchers case): that task must not hold the run open.
        const args = event.args as { readonly run_in_background?: unknown } | null | undefined;
        if (typeof args === 'object' && args !== null && args.run_in_background === true) {
          this.backgroundCalls.add(event.toolCallId);
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
        this.turnActive = false;
        this.lastTurnId = event.turnId;
        this.toolCalls.settleTurn(
          event.turnId,
          event.reason === 'completed' ? 'completed' : 'failed',
        );
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
        // settlement the upstream ACP server uses. Only a command the turn
        // backgrounded (its timeout moved it to background) keeps the run
        // alive: the engine reports it from the turn it starts on completion,
        // and until then the client must stay busy rather than think the
        // request is answered while its output is still arriving. A steered
        // prompt waiting for its turn takes precedence: it is the next turn.
        const reason = turnStopReason(event.reason, event.error);
        // A goal's continuation turns end one after another; the run they
        // belong to waits for the goal itself (a cancel still settles it here).
        if (run.goal === true && reason !== 'cancelled') {
          this.deferred = { run, reason };
          return;
        }
        if (reason !== 'cancelled' && this.heldTasks.size > 0 && !this.hasQueuedRun()) {
          this.deferred = { run, reason };
          log.info('acp: run waits for background work', {
            sessionId: this.sessionId,
            turnId: event.turnId,
            tasks: [...this.heldTasks],
          });
          return;
        }
        this.settle(run, reason);
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
          this.settleGoalRun('end_turn');
          if (this.goalId !== undefined) {
            void this.outbox.push(goalCleared(this.options.sessionId, this.goalId, 'Goal cleared.'));
            this.goalId = undefined;
          }
          void this.publishAirGoal(null);
          return;
        }
        void this.publishAirGoal(snapshot);
        // The goal is no longer working: the run that was waiting for it is
        // done. `active` keeps waiting, and a continuation turn ends into the
        // hold like a background task does.
        if (snapshot.status !== 'active') this.settleGoalRun('end_turn');
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
        const patch = (event as { readonly patch?: TitlePatch }).patch;
        const title = typeof event.title === 'string' ? event.title : undefined;
        if (isPublishableTitle(patch, title)) void this.publishSessionInfo(title);
        return;
      }
      case 'event.session.status_changed': {
        const run = this.run;
        if (event.status === 'idle' && run !== undefined && !run.settled && this.heldTasks.size === 0) {
          this.settle(run, 'end_turn');
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * The hold (deferred settlement and the tasks it waits on) belongs to the
   * live run only; a queued run that settles must not drop it.
   */
  private release(run: Run): void {
    if (this.run !== run) return;
    this.run = undefined;
    this.clearDeferred();
    this.heldTasks.clear();
  }

  /**
   * Retire the run exactly once. The response waits for the outbox so the
   * client renders the turns' output before the prompt looks answered.
   */
  private settle(run: Run, reason: StopReason): void {
    if (run.settled) return;
    run.settled = true;
    this.release(run);
    this.assistant.flushNow();
    this.thought.flushNow();
    void this.outbox.drain().then(() => {
      run.resolve(reason);
    });
    void this.suggestNextPrompt();
  }

  /**
   * A tool call outlived its turn as a background task (`background.task.*`).
   *
   * `background.task.started` is the engine's own statement that the work
   * continues after the tool call returned: either the model asked for it
   * (`run_in_background`, so it deliberately gave the turn back) or the
   * command hit its timeout and was moved to background instead of being
   * killed. The second is still the user's work, and the engine opens a new
   * turn when it finishes — so the run stays live, and the client keeps
   * composing instead of showing an answered prompt over running output.
   */
  private handleBackgroundTask(event: Event): void {
    const agentId = (event as { readonly agentId?: unknown }).agentId;
    if (typeof agentId === 'string' && agentId !== 'main') return;
    const info = (event as { readonly info?: BackgroundTaskInfoLike }).info;
    if (info === undefined) return;
    const taskId = typeof info.taskId === 'string' ? info.taskId : undefined;
    if (taskId === undefined) return;
    const parent = typeof info.parentToolCallId === 'string' ? info.parentToolCallId : undefined;
    if ((event.type as string) === 'background.task.started') {
      const run = this.run;
      if (run === undefined || run.settled) return;
      // Questions and other bookkeeping tasks are answered inside a live turn.
      if (info.kind !== 'process' && info.kind !== 'agent') return;
      if (parent !== undefined && this.backgroundCalls.has(parent)) return;
      this.heldTasks.add(taskId);
      // New work after a deferred turn end: the grace timer must not fire.
      this.cancelDeferredTimer();
      return;
    }
    this.heldTasks.delete(taskId);
    if (parent !== undefined) this.backgroundCalls.delete(parent);
    this.settleWhenTasksDone();
  }

  /** The last held task ended: settle, unless its continuation turn is coming. */
  private settleWhenTasksDone(): void {
    const deferred = this.deferred;
    if (deferred === undefined) return;
    if (deferred.run.settled || this.run !== deferred.run) {
      this.clearDeferred();
      return;
    }
    if (this.heldTasks.size > 0 || this.turnActive || this.deferredTimer !== undefined) return;
    const grace = this.options.followUpGraceMs ?? TASK_FOLLOW_UP_GRACE_MS;
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = undefined;
      const pending = this.deferred;
      this.deferred = undefined;
      if (pending === undefined || pending.run.settled || this.run !== pending.run) return;
      // A turn that started meanwhile owns the end; `turn.ended` settles it.
      if (this.heldTasks.size > 0 || this.turnActive) return;
      this.settle(pending.run, pending.reason);
      this.promoteQueued();
    }, grace);
    this.deferredTimer.unref?.();
  }

  private clearDeferred(): void {
    this.deferred = undefined;
    this.cancelDeferredTimer();
  }

  private cancelDeferredTimer(): void {
    if (this.deferredTimer === undefined) return;
    clearTimeout(this.deferredTimer);
    this.deferredTimer = undefined;
  }

  /** Stop a task the cancelled run was waiting on. Detached work has no turn to cancel. */
  private stopTask(taskId: string): void {
    void this.options.session.stopBackgroundTask(taskId).catch((error: unknown) => {
      log.warn('acp: failed to stop a background task', {
        sessionId: this.sessionId,
        taskId,
        error: describe(error),
      });
    });
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
    // The engine refused the submission: the turn the cancel is waiting to stop
    // will never start, so stop waiting for its id.
    if (this.cancelledRunAwaitingId === run) this.cancelledRunAwaitingId = undefined;
    if (run.settled) return;
    run.settled = true;
    this.release(run);
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