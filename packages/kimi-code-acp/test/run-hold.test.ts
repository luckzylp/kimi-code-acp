import { describe, expect, it } from 'vitest';

import type { Event, Session as KimiSession } from '@moonshot-ai/kimi-code-sdk';

import { SessionBridge, type SessionBridgeOptions } from '../src/session';

/**
 * The run model around background work (ADR 0001, Decision 2).
 *
 * A foreground command that hits its timeout is moved to the background
 * instead of being killed; the engine then opens a turn nobody prompted to
 * report the result. The client must stay composing across that gap — the
 * user's command is still running — and must not stay composing when the
 * model asked for a background task in the first place.
 */

type Listener = (event: Event) => void;

function fakeSession() {
  const listeners: Listener[] = [];
  const calls = { cancel: 0, stopped: [] as string[] };
  const session = {
    id: 'session_test',
    workDir: '/tmp',
    onEvent(listener: Listener): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
    prompt: () => Promise.resolve(undefined),
    cancel: () => {
      calls.cancel += 1;
      return Promise.resolve();
    },
    stopBackgroundTask: (taskId: string) => {
      calls.stopped.push(taskId);
      return Promise.resolve();
    },
  };
  return {
    session,
    calls,
    emit: (event: Record<string, unknown>) => {
      for (const listener of [...listeners]) listener(event as unknown as Event);
    },
  };
}

function bridgeWith(graceMs = 5) {
  const fake = fakeSession();
  const notifications: Array<Record<string, unknown>> = [];
  const bridge = new SessionBridge({
    sessionId: 'session_test',
    session: fake.session as unknown as KimiSession,
    shadowTerminals: false,
    followUpGraceMs: graceMs,
    send: (notification) => {
      notifications.push(notification as unknown as Record<string, unknown>);
    },
  } satisfies SessionBridgeOptions);
  return { ...fake, bridge, notifications };
}

/** One foreground command that the engine moved to the background on timeout. */
function foregroundCommand(overrides: { runInBackground?: boolean } = {}) {
  const args = overrides.runInBackground === true
    ? { command: 'npm run dev', run_in_background: true, description: 'dev server' }
    : { command: 'make ci', timeout: 2 };
  return {
    started: {
      type: 'tool.call.started',
      agentId: 'main',
      turnId: 1,
      toolCallId: 'call_1',
      name: 'Bash',
      args,
      display: { kind: 'command', command: args.command },
    },
    taskStarted: {
      type: 'background.task.started',
      agentId: 'main',
      info: { taskId: 'call_1', kind: 'process', parentToolCallId: 'call_1', status: 'running' },
    },
    taskTerminated: {
      type: 'background.task.terminated',
      agentId: 'main',
      info: { taskId: 'call_1', kind: 'process', parentToolCallId: 'call_1', status: 'completed' },
    },
  };
}

function turnStarted(turnId = 1, origin: Record<string, unknown> = { kind: 'user' }) {
  return { type: 'turn.started', agentId: 'main', turnId, origin, prompt: 'do it' };
}

function turnEnded(turnId = 1, reason = 'completed') {
  return { type: 'turn.ended', agentId: 'main', turnId, reason };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Track a run's settlement without awaiting it. */
function observe(run: Promise<string>) {
  const state: { reason?: string } = {};
  void run.then((reason) => {
    state.reason = reason;
  });
  return state;
}

describe('a run and the background work its turn started', () => {
  it('settles at the turn when nothing outlives it', async () => {
    const { bridge, emit } = bridgeWith();
    const state = observe(bridge.prompt('do it') as Promise<string>);
    emit(turnStarted());
    emit(turnEnded());
    await sleep(10);
    expect(state.reason).toBe('end_turn');
  });

  it('waits while an auto-backgrounded command still runs', async () => {
    const { bridge, emit } = bridgeWith();
    const command = foregroundCommand();
    const state = observe(bridge.prompt('do it') as Promise<string>);
    emit(turnStarted());
    emit(command.started);
    emit(command.taskStarted);
    emit(turnEnded());
    await sleep(30);
    expect(state.reason).toBeUndefined();
    expect(bridge.isBusy()).toBe(true);
  });

  it('settles once the task ends and no continuation turn follows', async () => {
    const { bridge, emit } = bridgeWith(5);
    const command = foregroundCommand();
    const state = observe(bridge.prompt('do it') as Promise<string>);
    emit(turnStarted());
    emit(command.started);
    emit(command.taskStarted);
    emit(turnEnded());
    emit(command.taskTerminated);
    await sleep(40);
    expect(state.reason).toBe('end_turn');
    expect(bridge.isBusy()).toBe(false);
  });

  it('stays live through the turn the engine starts for the finished task', async () => {
    const { bridge, emit } = bridgeWith(20);
    const command = foregroundCommand();
    const state = observe(bridge.prompt('do it') as Promise<string>);
    emit(turnStarted());
    emit(command.started);
    emit(command.taskStarted);
    emit(turnEnded());
    emit(command.taskTerminated);
    // The engine reports the result in a turn of its own.
    emit(turnStarted(2, { kind: 'task', taskId: 'call_1', status: 'completed' }));
    await sleep(60);
    expect(state.reason).toBeUndefined();
    emit(turnEnded(2));
    await sleep(10);
    expect(state.reason).toBe('end_turn');
  });

  it('does not wait on a task the model launched in the background', async () => {
    const { bridge, emit } = bridgeWith();
    const command = foregroundCommand({ runInBackground: true });
    const state = observe(bridge.prompt('do it') as Promise<string>);
    emit(turnStarted());
    emit(command.started);
    emit(command.taskStarted);
    emit(turnEnded());
    await sleep(30);
    // The model gave the turn back on purpose: a dev server is not a wait.
    expect(state.reason).toBe('end_turn');
  });

  it('settles cancelled and stops the tasks it was waiting on', async () => {
    const { bridge, emit, calls } = bridgeWith();
    const command = foregroundCommand();
    const state = observe(bridge.prompt('do it') as Promise<string>);
    emit(turnStarted());
    emit(command.started);
    emit(command.taskStarted);
    emit(turnEnded());
    await sleep(10);
    expect(state.reason).toBeUndefined();
    bridge.cancel();
    await sleep(10);
    expect(state.reason).toBe('cancelled');
    expect(calls.cancel).toBe(1);
    expect(calls.stopped).toEqual(['call_1']);
  });

  it('settles a cancelled turn without waiting for its tasks', async () => {
    const { bridge, emit } = bridgeWith();
    const command = foregroundCommand();
    const state = observe(bridge.prompt('do it') as Promise<string>);
    emit(turnStarted());
    emit(command.started);
    emit(command.taskStarted);
    emit(turnEnded(1, 'cancelled'));
    await sleep(10);
    expect(state.reason).toBe('cancelled');
  });

  it('ignores the tasks of child agents and of a settled run', async () => {
    const { bridge, emit } = bridgeWith();
    const state = observe(bridge.prompt('do it') as Promise<string>);
    emit(turnStarted());
    emit({ ...foregroundCommand().taskStarted, agentId: 'child' });
    emit(turnEnded());
    await sleep(10);
    expect(state.reason).toBe('end_turn');
    // A task that starts after the run settled cannot reopen it.
    emit(foregroundCommand().taskStarted);
    await sleep(10);
    expect(state.reason).toBe('end_turn');
    expect(bridge.isBusy()).toBe(false);
  });
});
