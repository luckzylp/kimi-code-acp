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

export function planNotification(
  sessionId: string,
  items: readonly TodoLike[],
): SessionNotification | null {
  if (items.length === 0) return null;
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
