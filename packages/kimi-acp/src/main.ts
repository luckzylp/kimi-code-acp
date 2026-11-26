/**
 * Entry point: `--version`, `--help`, or the ACP agent on stdio.
 *
 * stdout carries the protocol and nothing else; every diagnostic goes to stderr
 * (`log.ts`, and `redirectConsoleToStderr` for anything that sneaks in).
 */
import { Readable, Writable } from 'node:stream';

import { agentProtocolRouter, ndJsonStream as ndJsonStreamV2 } from '@agentclientprotocol/sdk/experimental/v2';

import { close as closeAgent, createAgentApp, createAgentState } from './agent';
import { runLogin } from './auth';
import { log, redirectConsoleToStderr } from './log';
import { createV2App } from './v2';
import { AGENT_NAME, VERSION } from './version';

const argv = process.argv.slice(2);

if (argv[0] === 'mcp-bridge') {
  // Spawned by the engine as a stdio MCP server for an ACP-hosted connection:
  // raw stdio ↔ socket, no logging on stdout.
  const socketPath = argv[1];
  if (socketPath === undefined) process.exit(2);
  const { connect } = await import('node:net');
  const socket = connect(socketPath);
  socket.on('error', () => process.exit(1));
  socket.on('close', () => process.exit(0));
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  process.stdin.on('end', () => socket.end());
  // Never fall through to the ACP server: this process only proxies bytes.
  await new Promise<never>(() => undefined);
} else if (argv[0] === 'login' || argv.includes('--login')) {
  // The ACP terminal auth method runs exactly this: the device-code flow in a
  // terminal the client opened for it.
  const code = await runLogin();
  process.exit(code);
}

if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(`${AGENT_NAME} ${VERSION}\n`);
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    `${AGENT_NAME} ${VERSION}\n\n` +
      'An ACP agent for kimi-code, spoken over stdio.\n\n' +
      'Usage:\n' +
      '  kimi-acp            serve ACP on stdin/stdout\n' +
      '  kimi-acp login      run the device-code login flow\n' +
      '  kimi-acp --version  print the version\n',
  );
  process.exit(0);
}

redirectConsoleToStderr();

// One connection, two protocol versions: the router reads the client's
// `initialize` and opens the v1 or the v2 app accordingly (ADR: v2 support).
const state = createAgentState();
const { app } = createAgentApp(state);
const { app: v2App } = createV2App(state);
const router = agentProtocolRouter().withV1(app).withV2(v2App);
const connection = router.connect(
  ndJsonStreamV2(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);

let closing = false;
async function shutdown(reason: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info('acp: shutting down', { reason });
  try {
    await closeAgent(state);
  } catch (error) {
    log.warn('acp: shutdown failed', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    process.exit(0);
  }
}

process.stdin.on('end', () => {
  void shutdown('stdin closed');
});
connection.closed?.finally(() => {
  void shutdown('connection closed');
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}