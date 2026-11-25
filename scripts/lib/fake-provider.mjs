/**
 * A fake OpenAI-compatible provider for the end-to-end script.
 *
 * The engine reaches a model through its protocol adapter, so an HTTP server
 * that streams a chat-completion chunk sequence is enough to drive a real turn
 * without any credentials or network.
 */
import { createServer } from 'node:http';

export async function startFakeProvider({ text = 'Hello, world.', delayMs = 20 } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ url: request.url, body });
      if (!(request.url ?? '').endsWith('/chat/completions')) {
        response.writeHead(404).end();
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
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'fake-model',
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      };
      // Two deltas, so the adapter's coalescing is exercised rather than one
      // chunk that would pass through either way.
      const half = Math.ceil(text.length / 2);
      send({ role: 'assistant', content: '' });
      send({ content: text.slice(0, half) });
      setTimeout(() => {
        send({ content: text.slice(half) });
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