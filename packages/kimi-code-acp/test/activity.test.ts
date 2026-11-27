import { describe, expect, it } from 'vitest';

import {
  compactionUpdate,
  goalBody,
  goalCard,
  goalChange,
  goalCleared,
  planNotification,
  subagentCard,
  subagentUpdate,
  type GoalSnapshotLike,
} from '../src/activity';

const SESSION = 'session_test';

function goal(overrides: Partial<GoalSnapshotLike> = {}): GoalSnapshotLike {
  return {
    goalId: 'g1',
    objective: 'Ship the login form\nwith tests',
    completionCriterion: 'tests green',
    status: 'active',
    turnsUsed: 3,
    tokensUsed: 1234,
    wallClockMs: 60_000,
    budget: { remainingTurns: 7, remainingTokens: 5000, remainingWallClockMs: null, overBudget: false },
    ...overrides,
  };
}

describe('planNotification', () => {
  it('maps todo statuses onto plan entry statuses', () => {
    const update = planNotification(SESSION, [
      { title: 'done step', status: 'done' },
      { title: 'running step', status: 'in_progress' },
      { title: 'later step', status: 'pending' },
    ]);
    expect(update?.update).toMatchObject({
      sessionUpdate: 'plan',
      entries: [
        { content: 'done step', priority: 'medium', status: 'completed' },
        { content: 'running step', priority: 'medium', status: 'in_progress' },
        { content: 'later step', priority: 'medium', status: 'pending' },
      ],
    });
  });

  it('emits nothing for an empty list', () => {
    expect(planNotification(SESSION, [])).toBeNull();
  });
});

describe('goal projection', () => {
  it('opens a card whose title is the objective and whose body has the budget', () => {
    const card = goalCard(SESSION, goal());
    expect(card.update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'goal:g1',
      title: 'Goal: Ship the login form',
      kind: 'other',
      status: 'in_progress',
    });
    const body = (card.update as { content: Array<{ content: { text: string } }> }).content[0]!.content.text;
    expect(body).toContain('Status: active');
    expect(body).toContain('Turns: 3');
    expect(body).toContain('Done when: tests green');
    expect(body).toContain('Budget left: 7 turns · 5,000 tokens');
  });

  it('maps lifecycle onto card status', () => {
    expect(goalCard(SESSION, goal({ status: 'complete' })).update).toMatchObject({ status: 'completed' });
    expect(goalCard(SESSION, goal({ status: 'blocked' })).update).toMatchObject({ status: 'failed' });
    expect(goalCard(SESSION, goal({ status: 'paused' })).update).toMatchObject({ status: 'in_progress' });
  });

  it('updates the same card instead of opening another', () => {
    const change = goalChange(SESSION, goal({ status: 'complete', turnsUsed: 9 }));
    expect(change.update).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'goal:g1', status: 'completed' });
    expect(goalBody(goal({ turnsUsed: 9 }))).toContain('Turns: 9');
  });

  it('closes a cleared goal', () => {
    expect(goalCleared(SESSION, 'g1', 'Goal cleared.').update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'goal:g1',
      status: 'completed',
    });
  });
});

describe('compaction update', () => {
  it('reports lifecycle states with the same id', () => {
    const started = compactionUpdate(SESSION, 'c1', 'in_progress');
    expect(started.update).toMatchObject({
      sessionUpdate: 'compaction_update',
      compactionId: 'c1',
      status: 'in_progress',
    });
    const done = compactionUpdate(SESSION, 'c1', 'completed', 'Compaction completed.');
    expect(done.update).toMatchObject({ status: 'completed' });
    expect(JSON.stringify(done)).toContain('Compaction completed.');
    const failed = compactionUpdate(SESSION, 'c1', 'failed', 'blocked');
    expect(failed.update).toMatchObject({ status: 'failed', error: 'blocked' });
  });
});

describe('subagent projection', () => {
  it('opens a card and moves it through states', () => {
    const card = subagentCard(SESSION, {
      subagentId: 's1',
      subagentName: 'reviewer',
      description: 'review the diff',
      swarmIndex: 1,
    });
    expect(card.update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'subagent:s1',
      title: 'Subagent: reviewer #2',
      status: 'pending',
    });
    expect(subagentUpdate(SESSION, 's1', 'in_progress', undefined).update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'subagent:s1',
      status: 'in_progress',
    });
    const done = subagentUpdate(SESSION, 's1', 'completed', 'looks good');
    expect(done.update).toMatchObject({ status: 'completed' });
    expect(JSON.stringify(done)).toContain('looks good');
    expect(subagentUpdate(SESSION, 's1', 'failed', 'boom').update).toMatchObject({ status: 'failed' });
  });
});


