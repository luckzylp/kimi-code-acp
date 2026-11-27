/**
 * A fake OpenAI-compatible provider for the end-to-end scripts.
 *
 * The engine reaches a model through its protocol adapter, so an HTTP server
 * that streams chat-completion chunks is enough to drive real turns — text or
 * tool calls — with no credentials and no network.
 *
 *   startFakeProvider({ script: [{ kind: 'text', text: 'hi' }] })
 *   startFakeProvider({ script: [{ kind: 'tool', id: 'call_1', name: 'Bash', arguments: '{"command":"echo hi"}' }] })
 *
 * Each request shifts one script entry; running out fails the turn loudly
 * rather than answering with an empty message.
 *
 * The adapter also asks for a session title over the same endpoint (a
 * non-streamed completion). `titleScript` answers those on their own cursor,
 * so a test that titles at prompt time need not interleave its entries with
 * the turn's; without it a title request shifts the turn script as before.
 */
import { createServer } from 'node:http';

export async function startFakeProvider({ script, titleScript, text = 'Hello, world.', delayMs = 20, titleDelayMs = 0 } = {}) {
  const responses = script ?? [{ kind: 'text', text }];
  const requests = [];
  let cursor = 0;
  let titleCursor = 0;
  const textEntry = (entry) => (entry.kind === 'text' ? entry.text : '');
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ url: request.url, body, headers: request.headers });
      if (!(request.url ?? '').endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined;
      }
      const titleRequest = parsed?.stream === false && titleScript !== undefined;
      const entry = titleRequest ? titleScript[titleCursor] : responses[cursor];
      if (titleRequest) titleCursor += 1;
      else cursor += 1;
      if (entry === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'fake provider script exhausted' } }));
        return;
      }
      if (parsed?.stream === false) {
        if (entry === undefined || entry.kind !== 'text') {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'fake provider script exhausted' } }));
          return;
        }
        const answer = () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              id: 'chatcmpl-title',
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: entry.text }, finish_reason: 'stop' }],
            }),
          );
        };
        if (titleDelayMs > 0) setTimeout(answer, titleDelayMs).unref?.();
        else answer();
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (delta, finishReason = null) => {
        response.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${cursor}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'fake-model',
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      };
      send({ role: 'assistant', content: '' });
      if (entry.kind === 'tool') {
        send({
          tool_calls: [
            {
              index: 0,
              id: entry.id,
              type: 'function',
              function: { name: entry.name, arguments: entry.arguments },
            },
          ],
        });
        send({}, 'tool_calls');
        response.write('data: [DONE]\n\n');
        response.end();
        return;
      }
      // Two deltas, so the adapter's coalescing is exercised rather than one
      // chunk that would pass through either way.
      const value = entry.text;
      const half = Math.ceil(value.length / 2);
      send({ content: value.slice(0, half) });
      setTimeout(() => {
        send({ content: value.slice(half) });
        send({}, 'stop');
        response.write('data: [DONE]\n\n');
        response.end();
      }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
