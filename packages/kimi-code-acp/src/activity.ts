/**
 * Activity the client renders but the engine does not express as a tool call:
 * todo lists, goals, subagents, compaction (ADR 0001, Decision 4).
 *
 * ACP v1 has no goal or subagent entity, so each becomes a synthetic tool card
 * whose id is stable across updates — `goal:<goalId>`, `subagent:<id>` — and a
 * todo list becomes the session's `plan`. Pure builders: no state, so the live
 * path and the `session/load` replay produce identical updates.
 */
import { randomUUID } from 'node:crypto';

import type { PlanEntry, SessionNotification } from '@agentclientprotocol/sdk/unstable';

/** The goal state this projection reads (engine `GoalSnapshot`). */
export interface GoalSnapshotLike {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: 'active' | 'paused' | 'blocked' | 'complete';
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly budget?: {
    readonly remainingTurns: number | null;
    readonly remainingTokens: number | null;
    readonly remainingWallClockMs: number | null;
    readonly overBudget: boolean;
  };
  readonly terminalReason?: string;
}

/** One todo item, as the engine's TodoList display carries it. */
export interface TodoLike {
  readonly title: string;
  readonly status: string;
}

export interface SubagentSpawnedLike {
  readonly subagentId: string;
  readonly subagentName: string;
  readonly description?: string;
  readonly swarmIndex?: number;
  readonly runInBackground?: boolean;
}

/**
 * The `plan` update for a TodoList. An emptied list reports `entries: []`
 * (the client hides an empty plan) once a plan was on screen; a first empty
 * list sends nothing.
 */
export function planNotification(
  sessionId: string,
  items: readonly TodoLike[],
  shown = false,
): SessionNotification | null {
  if (items.length === 0 && !shown) return null;
  return {
    sessionId,
    update: {
      sessionUpdate: 'plan',
      entries: items.map((item): PlanEntry => ({
        content: item.title,
        priority: 'medium',
        status: planStatus(item.status),
      })),
    },
  };
}

function planStatus(status: string): PlanEntry['status'] {
  switch (status) {
    case 'done':
    case 'completed':
      return 'completed';
    case 'in_progress':
      return 'in_progress';
    default:
      return 'pending';
  }
}

/** The ACP status a goal's lifecycle maps to. */
export function goalCallStatus(snapshot: GoalSnapshotLike): 'in_progress' | 'completed' | 'failed' {
  if (snapshot.status === 'complete') return 'completed';
  if (snapshot.status === 'blocked') return 'failed';
  return 'in_progress';
}

export function goalTitle(snapshot: GoalSnapshotLike): string {
  const firstLine = snapshot.objective.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  return `Goal: ${firstLine ?? snapshot.goalId}`;
}

export function goalBody(snapshot: GoalSnapshotLike): string {
  const lines = [
    `Status: ${snapshot.status}`,
    `Turns: ${String(snapshot.turnsUsed)} · Tokens: ${snapshot.tokensUsed.toLocaleString('en-US')}`,
  ];
  if (snapshot.completionCriterion !== undefined && snapshot.completionCriterion.length > 0) {
    lines.push(`Done when: ${snapshot.completionCriterion}`);
  }
  const budget = snapshot.budget;
  if (budget !== undefined && !budget.overBudget) {
    const remaining = [
      budget.remainingTurns === null ? undefined : `${String(budget.remainingTurns)} turns`,
      budget.remainingTokens === null ? undefined : `${budget.remainingTokens.toLocaleString('en-US')} tokens`,
    ].filter((entry): entry is string => entry !== undefined);
    if (remaining.length > 0) lines.push(`Budget left: ${remaining.join(' · ')}`);
  }
  if (snapshot.terminalReason !== undefined && snapshot.terminalReason.length > 0) {
    lines.push(`Reason: ${snapshot.terminalReason}`);
  }
  return lines.join('\n');
}

/** The goal's card. Emitted once per goal id; later changes are updates. */
export function goalCard(sessionId: string, snapshot: GoalSnapshotLike): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: `goal:${snapshot.goalId}`,
      title: goalTitle(snapshot),
      kind: 'other',
      status: goalCallStatus(snapshot),
      content: [{ type: 'content', content: { type: 'text', text: goalBody(snapshot) } }],
    },
  };
}

/** A change to a goal already on screen. */
export function goalChange(sessionId: string, snapshot: GoalSnapshotLike): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: `goal:${snapshot.goalId}`,
      status: goalCallStatus(snapshot),
      content: [{ type: 'content', content: { type: 'text', text: goalBody(snapshot) } }],
    },
  };
}

/** A goal that ended (cleared, completed) — close the card instead of leaving it running. */
export function goalCleared(sessionId: string, goalId: string, reason: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: `goal:${goalId}`,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: reason } }],
    },
  };
}

export function subagentCard(sessionId: string, spawned: SubagentSpawnedLike): SessionNotification {
  const index = spawned.swarmIndex === undefined ? '' : ` #${String(spawned.swarmIndex + 1)}`;
  const lines = [
    spawned.description ?? `Subagent ${spawned.subagentName}`,
    spawned.runInBackground === true ? 'Running in the background.' : 'Waiting for its result.',
  ];
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: `subagent:${spawned.subagentId}`,
      title: `Subagent: ${spawned.subagentName}${index}`,
      kind: 'other',
      status: 'pending',
      content: [{ type: 'content', content: { type: 'text', text: lines.join('\n') } }],
    },
  };
}

export function subagentUpdate(
  sessionId: string,
  subagentId: string,
  status: 'in_progress' | 'completed' | 'failed',
  text: string | undefined,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: `subagent:${subagentId}`,
      status,
      ...(text === undefined
        ? {}
        : { content: [{ type: 'content' as const, content: { type: 'text' as const, text } }] }),
    },
  };
}

/** The ACP session id a subagent's live traffic is delivered under. */
export function subagentSessionId(parentSessionId: string, subagentId: string): string {
  return `subagent:${parentSessionId}:${subagentId}`;
}

export type SubagentState =
  | { readonly state: 'running' }
  | { readonly state: 'idle'; readonly stopReason?: 'end_turn' | 'cancelled' }
  | { readonly state: 'requires_action' }
  | { readonly state: 'unknown' };

/**
 * A `subagent_update` on the parent session (clients that declared `subagents`):
 * the first one announces the child, later ones patch its state.
 */
export function subagentAnnouncement(
  parentSessionId: string,
  subagentId: string,
  patch: { readonly title?: string; readonly description?: string; readonly cwd?: string; readonly state?: SubagentState },
): SessionNotification {
  return {
    sessionId: parentSessionId,
    update: {
      sessionUpdate: 'subagent_update',
      sessionId: subagentSessionId(parentSessionId, subagentId),
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.cwd === undefined ? {} : { cwd: patch.cwd }),
      ...(patch.state === undefined ? {} : { state: patch.state }),
    },
  } as SessionNotification;
}

/** The lifecycle states ACP defines for a compaction. */
export type CompactionStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled';

/** A `compaction_update`, for clients that declare `session.compaction`. */
export function compactionUpdate(
  sessionId: string,
  compactionId: string,
  status: CompactionStatus,
  errorOrSummary?: string,
): SessionNotification {
  const isError = status === 'failed';
  return {
    sessionId,
    update: {
      sessionUpdate: 'compaction_update',
      compactionId,
      status,
      ...(errorOrSummary === undefined
        ? {}
        : isError
          ? { error: errorOrSummary }
          : { summary: [{ type: 'text', text: errorOrSummary }] }),
    },
  };
}

/** A structured `notice` update, for clients that declare `session.notices`. */
export function structuredNotice(
  sessionId: string,
  severity: 'info' | 'warning' | 'error',
  title: string,
  description?: string,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'notice',
      severity,
      title,
      ...(description === undefined ? {} : { description }),
    },
  };
}

/** A one-line system notice in the transcript (compaction, notices). */
export function notice(sessionId: string, text: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
      messageId: randomUUID(),
    },
  };
}