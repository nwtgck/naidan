import { request as httpRequest, type ClientRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRequestSequenceHandler,
  createStreamingResponse,
  startMockServer,
  type MockServer,
  type MockServerHandled,
} from './index';

const servers: MockServer[] = [];

afterEach(async () => {
  const closing = servers.splice(0).map(async (server) => await server.close());
  await Promise.allSettled(closing);
});

describe('mock server v2', () => {
  it('captures request bytes independently from handler body consumption', async () => {
    const server = await startMockServer({
      handler: async ({ request, requestNumber }) => {
        expect(requestNumber).toBe(1);
        expect(request.method).toBe('POST');
        expect(new URL(request.url).pathname).toBe('/items');
        expect(new URL(request.url).searchParams.get('mode')).toBe('test');
        expect(request.headers.get('x-example')).toBe('yes');
        expect(await request.json()).toEqual({ message: 'こんにちは' });
        return Response.json({ ok: true }, { status: 201 });
      },
    });
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/items?mode=test`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-example': 'yes',
      },
      body: JSON.stringify({ message: 'こんにちは' }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.requestNumber).toBe(1);
    expect(await server.requests[0]!.text()).toBe('{"message":"こんにちは"}');
    expect(await server.requests[0]!.text()).toBe('{"message":"こんにちは"}');
    expect(await server.requests[0]!.json()).toEqual({ message: 'こんにちは' });
    expect(new TextDecoder().decode(server.requests[0]!.rawBody)).toBe('{"message":"こんにちは"}');
  });

  it('uses server-global request numbers for sequence handlers', async () => {
    const server = await startMockServer({
      handler: createRequestSequenceHandler({
        handlers: [
          ({ requestNumber }) => new Response(`first:${requestNumber}`),
          ({ requestNumber }) => new Response(`second:${requestNumber}`),
          ({ requestNumber }) => new Response(`third:${requestNumber}`),
        ],
      }),
    });
    servers.push(server);

    expect(await (await fetch(`${server.baseUrl}/a`)).text()).toBe('first:1');
    expect(await (await fetch(`${server.baseUrl}/b`)).text()).toBe('second:2');
    expect(await (await fetch(`${server.baseUrl}/c`)).text()).toBe('third:3');
    expect(server.requests.map(({ requestNumber }) => requestNumber)).toEqual([1, 2, 3]);
  });

  it('does not surface an aborted request body as a handler error', async () => {
    const server = await startMockServer({
      handler: () => new Response('ok'),
    });
    servers.push(server);

    const abortedRequest = httpRequest(`${server.baseUrl}/aborted-body`, {
      method: 'POST',
      headers: { 'content-length': '2' },
    });
    const requestClosed = new Promise<void>(resolve => abortedRequest.once('close', resolve));
    await new Promise<void>((resolve, reject) => {
      abortedRequest.once('error', () => resolve());
      abortedRequest.once('socket', (socket) => {
        const sendPartialBody = () => {
          abortedRequest.write('a', (error) => {
            if (error) reject(error);
            else {
              abortedRequest.destroy();
              resolve();
            }
          });
        };
        if (socket.connecting) socket.once('connect', sendPartialBody);
        else sendPartialBody();
      });
    });
    await requestClosed;

    expect(await (await fetch(`${server.baseUrl}/after-abort`)).text()).toBe('ok');
    await expect(server.close()).resolves.toBeUndefined();
  });

  it('streams string and byte chunks in order', async () => {
    const server = await startMockServer({
      handler: () => createStreamingResponse({
        chunks: ['data: one\n\n', new TextEncoder().encode('data: 二\n\n')],
        init: { headers: { 'content-type': 'text/event-stream' } },
      }),
    });
    servers.push(server);

    const response = await fetch(server.baseUrl);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe(`\
data: one

data: 二

`);
  });

  it('cancels a streaming response when the client disconnects', async () => {
    let cancelled = false;
    const server = await startMockServer({
      handler: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('first'));
        },
        cancel() {
          cancelled = true;
        },
      })),
    });
    servers.push(server);

    const abortController = new AbortController();
    const response = await fetch(server.baseUrl, { signal: abortController.signal });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');

    abortController.abort();
    await expect(reader.read()).rejects.toBeDefined();
    await server.close();
    expect(cancelled).toBe(true);
  });

  it('closes a taken-over hanging response and remains idempotent', async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const server = await startMockServer({
      handler: ({ node }) => {
        node.response.writeHead(200, { 'content-type': 'text/plain' });
        node.response.write('partial');
        markStarted!();
        return node.takeOver();
      },
    });
    servers.push(server);

    const request = fetch(server.baseUrl).catch(() => undefined);
    await started;
    await server.close();
    await server.close();
    await request;
  });

  it('surfaces handler errors from close with a stable outcome', async () => {
    const expected = new Error('fixture failed');
    const server = await startMockServer({
      handler: async () => {
        await Promise.resolve();
        throw expected;
      },
    });
    servers.push(server);

    await expect(fetch(server.baseUrl)).rejects.toBeDefined();
    await expect(server.close()).rejects.toBe(expected);
    await expect(server.close()).rejects.toBe(expected);
  });

  it('rejects requests beyond a configured sequence', async () => {
    const server = await startMockServer({
      handler: createRequestSequenceHandler({
        handlers: [() => new Response('only')],
      }),
    });
    servers.push(server);

    expect(await (await fetch(server.baseUrl)).text()).toBe('only');
    await expect(fetch(server.baseUrl)).rejects.toBeDefined();
    await expect(server.close()).rejects.toThrow('Unexpected mock server request #2');
  });

  it('preserves empty and binary request bodies and response metadata', async () => {
    const binaryBody = new Uint8Array([0, 1, 127, 128, 255]);
    const server = await startMockServer({
      handler: async ({ request, requestNumber }) => {
        if (requestNumber === 1) {
          expect(request.method).toBe('POST');
          expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array());
          return new Response('empty', {
            status: 202,
            headers: { 'x-mock-kind': 'empty' },
          });
        }

        expect(requestNumber).toBe(2);
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(binaryBody);
        return new Response(binaryBody, {
          status: 206,
          headers: {
            'content-type': 'application/octet-stream',
            'x-mock-kind': 'binary',
          },
        });
      },
    });
    servers.push(server);

    const emptyResponse = await fetch(`${server.baseUrl}/empty`, { method: 'POST' });
    expect(emptyResponse.status).toBe(202);
    expect(emptyResponse.headers.get('x-mock-kind')).toBe('empty');
    expect(await emptyResponse.text()).toBe('empty');

    const binaryResponse = await fetch(`${server.baseUrl}/binary`, {
      method: 'POST',
      body: binaryBody,
    });
    expect(binaryResponse.status).toBe(206);
    expect(binaryResponse.headers.get('content-type')).toBe('application/octet-stream');
    expect(binaryResponse.headers.get('x-mock-kind')).toBe('binary');
    expect(new Uint8Array(await binaryResponse.arrayBuffer())).toEqual(binaryBody);

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]!.rawBody).toEqual(new Uint8Array());
    expect(server.requests[1]!.rawBody).toEqual(binaryBody);
  });

  it('keeps server-global arrival numbers when concurrent body capture completes out of order', async () => {
    const server = await startMockServer({
      handler: ({ requestNumber }) => new Response(String(requestNumber)),
    });
    servers.push(server);

    let firstRequest: ClientRequest | undefined;
    const firstResponseText = new Promise<string>((resolve, reject) => {
      firstRequest = httpRequest(`${server.baseUrl}/slow-body`, {
        method: 'POST',
        headers: { 'content-length': '2' },
      }, (response) => {
        const chunks: Uint8Array[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(new Uint8Array(chunk)));
        response.on('end', () => resolve(new TextDecoder().decode(Buffer.concat(chunks))));
        response.on('error', reject);
      });
      firstRequest.on('error', reject);
      firstRequest.write('a');
      firstRequest.flushHeaders();
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    const secondResponse = await fetch(`${server.baseUrl}/fast-body`, {
      method: 'POST',
      body: 'done',
    });
    expect(await secondResponse.text()).toBe('2');

    firstRequest!.end('b');
    expect(await firstResponseText).toBe('1');
    expect(server.requests.map(({ requestNumber }) => requestNumber)).toEqual([1, 2]);
    expect(await server.requests[0]!.text()).toBe('ab');
    expect(await server.requests[1]!.text()).toBe('done');
  });

  it('composes normal, streaming, and takeover handlers in one global sequence', async () => {
    const server = await startMockServer({
      handler: createRequestSequenceHandler({
        handlers: [
          () => new Response('normal'),
          () => createStreamingResponse({ chunks: ['stream', 'ed'], init: undefined }),
          ({ node }) => {
            node.response.writeHead(203, { 'content-type': 'text/plain' });
            node.response.end('taken-over');
            return node.takeOver();
          },
        ],
      }),
    });
    servers.push(server);

    expect(await (await fetch(`${server.baseUrl}/normal`)).text()).toBe('normal');
    expect(await (await fetch(`${server.baseUrl}/stream`)).text()).toBe('streamed');
    const takenOver = await fetch(`${server.baseUrl}/takeover`);
    expect(takenOver.status).toBe(203);
    expect(await takenOver.text()).toBe('taken-over');
    expect(server.requests.map(({ requestNumber }) => requestNumber)).toEqual([1, 2, 3]);
  });

  it('streams NDJSON and protocol prefixes across enqueue units', async () => {
    const server = await startMockServer({
      handler: () => createStreamingResponse({
        chunks: [
          '{"kind":',
          new TextEncoder().encode(`\
"first"}
{"kind"`),
          ':"second"}\n',
        ],
        init: { headers: { 'content-type': 'application/x-ndjson' } },
      }),
    });
    servers.push(server);

    const response = await fetch(server.baseUrl);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson');
    expect(await response.text()).toBe(`\
{"kind":"first"}
{"kind":"second"}
`);
  });

  it('supports delayed handlers without serializing later requests', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve;
    });
    const server = await startMockServer({
      handler: async ({ requestNumber }) => {
        if (requestNumber === 1) {
          markFirstStarted!();
          await firstGate;
        }
        return new Response(String(requestNumber));
      },
    });
    servers.push(server);

    const firstResponse = fetch(`${server.baseUrl}/delayed`).then(async response => await response.text());
    await firstStarted;
    const secondResponse = await fetch(`${server.baseUrl}/immediate`);
    expect(await secondResponse.text()).toBe('2');

    releaseFirst!();
    expect(await firstResponse).toBe('1');
  });

  it('closes without waiting for a delayed handler to finish', async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>(resolve => {
      releaseHandler = resolve;
    });

    const server = await startMockServer({
      handler: async ({ node }): Promise<MockServerHandled> => {
        markStarted!();
        await handlerGate;
        return node.takeOver();
      },
    });
    servers.push(server);

    const request = fetch(server.baseUrl).catch(() => undefined);
    await started;

    const closePromise = server.close();
    const closedBeforeHandlerRelease = await Promise.race([
      closePromise.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 200)),
    ]);

    releaseHandler!();
    await closePromise;
    await request;
    expect(closedBeforeHandlerRelease).toBe(true);
  });

  it('cancels a response body returned after the server is already closed', async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>(resolve => {
      releaseHandler = resolve;
    });
    let markCancelled: (() => void) | undefined;
    const cancelled = new Promise<void>(resolve => {
      markCancelled = resolve;
    });
    const neverSettles = new Promise<void>(() => undefined);

    const server = await startMockServer({
      handler: async () => {
        markStarted!();
        await handlerGate;
        return new Response(new ReadableStream<Uint8Array>({
          cancel() {
            markCancelled!();
            return neverSettles;
          },
        }));
      },
    });
    servers.push(server);

    const request = fetch(server.baseUrl).catch(() => undefined);
    await started;
    await server.close();
    releaseHandler!();

    await Promise.race([
      cancelled,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Response body was not cancelled.')), 200)),
    ]);
    await request;
  });

  it('closes even when response body cancellation never settles', async () => {
    let markCancelled: (() => void) | undefined;
    const cancelled = new Promise<void>(resolve => {
      markCancelled = resolve;
    });
    const neverSettles = new Promise<void>(() => undefined);
    const server = await startMockServer({
      handler: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('first'));
        },
        cancel() {
          markCancelled!();
          return neverSettles;
        },
      })),
    });
    servers.push(server);

    const abortController = new AbortController();
    const response = await fetch(server.baseUrl, { signal: abortController.signal });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');

    abortController.abort();
    await cancelled;
    const closePromise = server.close();
    const closedPromptly = await Promise.race([
      closePromise.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 200)),
    ]);

    expect(closedPromptly).toBe(true);
  });

  it('supports a mid-stream disconnect takeover and still closes cleanly', async () => {
    const server = await startMockServer({
      handler: ({ node }) => {
        node.response.writeHead(200, { 'content-type': 'text/plain' });
        node.response.write('partial');
        node.response.destroy();
        return node.takeOver();
      },
    });
    servers.push(server);

    await expect(fetch(server.baseUrl).then(async response => await response.text())).rejects.toBeDefined();
    await server.close();
    await server.close();
  });

});
