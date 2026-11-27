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
    steer: () => Promise.resolve(undefined),
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

function bridgeWith(graceMs = 5, sessionOverrides: Record<string, unknown> = {}) {
  const fake = fakeSession();
  Object.assign(fake.session, sessionOverrides);
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

/** The engine names the prompt behind a turn at its first step (`origin.kind` tells whose it is). */
function turnPrompt(turnId: number, origin: Record<string, unknown>) {
  return { type: 'turn.prompt', agentId: 'main', turnId, origin, promptId: `prompt_${turnId}`, input: [] };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Track a run's settlement without awaiting it. */
function observe(run: Promise<string>) {
  const state: { reason?: string; error?: unknown } = {};
  void run.then(
    (reason) => {
      state.reason = reason;
    },
    (error: unknown) => {
      state.error = error;
    },
  );
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

  it('yields the hold to a prompt steered while the run waits, so each prompt settles with its own turn', async () => {
    const { bridge, emit } = bridgeWith();
    const command = foregroundCommand();
    const first = observe(bridge.prompt('do it') as Promise<string>);
    emit(turnStarted());
    emit(command.started);
    emit(command.taskStarted);
    emit(turnEnded());
    await sleep(10);
    expect(first.reason).toBeUndefined();
    // The user sends a second prompt while the first is held: the engine (idle)
    // runs it as the next turn at once, and that turn belongs to the second run.
    const second = observe(bridge.steerAsRun('and this too') as Promise<string>);
    emit(turnStarted(2, { kind: 'user' }));
    emit(turnPrompt(2, { kind: 'user' }));
    await sleep(10);
    expect(first.reason).toBe('end_turn');
    expect(second.reason).toBeUndefined();
    expect(bridge.isBusy()).toBe(true);
    emit(turnEnded(2));
    await sleep(10);
    expect(second.reason).toBe('end_turn');
    expect(bridge.isBusy()).toBe(false);
    // The command's result turn now belongs to nobody: an engine turn, not a run.
    emit(command.taskTerminated);
    emit(turnStarted(3, { kind: 'task', taskId: 'call_1', status: 'completed' }));
    emit(turnPrompt(3, { kind: 'task', taskId: 'call_1' }));
    emit(turnEnded(3));
    await sleep(10);
    expect(first.reason).toBe('end_turn');
    expect(second.reason).toBe('end_turn');
    expect(bridge.isBusy()).toBe(false);
  });

  it('does not hold the run behind a prompt steered during its turn', async () => {
    const { bridge, emit } = bridgeWith();
    const command = foregroundCommand();
    const first = observe(bridge.prompt('do it') as Promise<string>);
    emit(turnStarted());
    emit(command.started);
    emit(command.taskStarted);
    // Steered while the model still works; the engine ends the turn at the step
    // boundary and runs the message as the next turn.
    const second = observe(bridge.steerAsRun('and this too') as Promise<string>);
    emit(turnEnded());
    await sleep(10);
    expect(first.reason).toBe('end_turn');
    expect(second.reason).toBeUndefined();
    emit(turnStarted(2, { kind: 'user' }));
    emit(turnPrompt(2, { kind: 'user' }));
    emit(turnEnded(2));
    await sleep(10);
    expect(second.reason).toBe('end_turn');
    expect(bridge.isBusy()).toBe(false);
  });

  it('keeps the hold when the steered prompt fails to submit', async () => {
    const { bridge, emit } = bridgeWith(5, { steer: () => Promise.reject(new Error('session closed')) });
    const command = foregroundCommand();
    const first = observe(bridge.prompt('do it') as Promise<string>);
    emit(turnStarted());
    emit(command.started);
    emit(command.taskStarted);
    emit(turnEnded());
    await sleep(10);
    const second = observe(bridge.steerAsRun('and this too') as Promise<string>);
    await sleep(10);
    expect(second.error).toBeInstanceOf(Error);
    expect(first.reason).toBeUndefined();
    // The first run still waits for its command, and still settles when it ends.
    emit(command.taskTerminated);
    await sleep(40);
    expect(first.reason).toBe('end_turn');
    expect(bridge.isBusy()).toBe(false);
  });

  it('settles a cancel that no turn will ever answer', async () => {
    const { bridge, emit } = bridgeWith();
    const first = observe(bridge.prompt('do it') as Promise<string>);
    emit(turnStarted());
    const second = observe(bridge.steerAsRun('and this too') as Promise<string>);
    // The turn ends `completed`, so the steered run is promoted to lead the
    // next turn — which the cancel then stops before it ever starts.
    emit(turnEnded());
    await sleep(5);
    bridge.cancel();
    await sleep(10);
    expect(second.reason).toBe('cancelled');
    expect(first.reason).toBe('end_turn');
    expect(bridge.isBusy()).toBe(false);
  });

  it('stops the turn of a run cancelled before that turn started', async () => {
    const { bridge, emit, calls } = bridgeWith();
    const first = observe(bridge.prompt('do it') as Promise<string>);
    // The engine cannot cancel a prompt with no active turn, so the answer is
    // ours to give and the turn is ours to stop once it starts.
    bridge.cancel();
    await sleep(5);
    expect(first.reason).toBe('cancelled');
    expect(bridge.isBusy()).toBe(false);
    emit(turnStarted());
    emit(turnEnded(1, 'cancelled'));
    await sleep(5);
    expect(calls.cancel).toBe(2);
    expect(first.reason).toBe('cancelled');
    expect(bridge.isBusy()).toBe(false);
  });

  it('leaves the orphan turn alone when a newer prompt owns the session', async () => {
    const { bridge, emit, calls } = bridgeWith();
    const first = observe(bridge.prompt('do it') as Promise<string>);
    bridge.cancel();
    await sleep(5);
    expect(first.reason).toBe('cancelled');
    // The user sent another prompt before the cancelled one's turn began; the
    // engine queues it behind that turn, so stopping the turn would abort the
    // continuation it needs.
    const second = observe(bridge.prompt('and this') as Promise<string>);
    emit(turnStarted());
    expect(calls.cancel).toBe(1);
    emit(turnEnded());
    await sleep(5);
    expect(second.reason).toBe('end_turn');
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
