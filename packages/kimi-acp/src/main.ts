/**
 * Entry point: `--version`, `--help`, or the ACP agent on stdio.
 *
 * stdout carries the protocol and nothing else; every diagnostic goes to stderr
 * (`log.ts`, and `redirectConsoleToStderr` for anything that sneaks in).
 */
import { Readable, Writable } from 'node:stream';

import { ndJsonStream } from '@agentclientprotocol/sdk';

import { createAgentApp } from './agent';
import { log, redirectConsoleToStderr } from './log';
import { AGENT_NAME, VERSION } from './version';

const argv = process.argv.slice(2);

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
      '  kimi-acp --version  print the version\n',
  );
  process.exit(0);
}

redirectConsoleToStderr();

const { app, close } = createAgentApp();
const connection = app.connect(
  ndJsonStream(
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
    await close();
  } catch (error) {
    log.warn('acp: shutdown failed', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    process.exit(0);
  }
}

process.stdin.on('end', () => {
  void shutdown('stdin closed');
});
connection.closed.finally(() => {
  void shutdown('connection closed');
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
