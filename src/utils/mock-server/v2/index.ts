import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

const handledToken = Symbol('mock-server-handled');

export type MockServerHandled = typeof handledToken;

export interface CapturedRequest {
  readonly requestNumber: number,
  readonly request: Request,
  readonly rawBody: Uint8Array,
  text(): Promise<string>,
  json(): Promise<unknown>,
}

export interface MockServerNodeAccess {
  readonly response: ServerResponse,
  takeOver(): MockServerHandled,
}

export interface MockServerHandlerContext {
  readonly request: Request,
  readonly requestNumber: number,
  readonly node: MockServerNodeAccess,
}

export type MockServerHandler = ({ request, requestNumber, node }: MockServerHandlerContext) =>
  | Response
  | MockServerHandled
  | Promise<Response | MockServerHandled>;

export interface MockServer {
  readonly baseUrl: string,
  readonly requests: readonly CapturedRequest[],
  close(): Promise<void>,
}

export async function startMockServer({ handler }: {
  handler: MockServerHandler,
}): Promise<MockServer> {
  let requestCount = 0;
  const capturedRequests: CapturedRequest[] = [];
  const sockets = new Set<Socket>();
  const handlerErrors: unknown[] = [];
  const activeResponseCleanups = new Set<() => Promise<void>>();

  const server = createServer((incoming, response) => {
    const requestNumber = ++requestCount;
    void handleIncomingRequest({
      incoming,
      response,
      requestNumber,
      handler,
      capturedRequests,
      handlerErrors,
      activeResponseCleanups,
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const baseUrl = await listenOnEphemeralPort({ server });
  let closePromise: Promise<void> | undefined;

  return {
    baseUrl,
    get requests() {
      return [...capturedRequests].sort((a, b) => a.requestNumber - b.requestNumber);
    },
    close() {
      closePromise ??= (async () => {
        const serverClosed = new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });

        for (const socket of sockets) socket.destroy();
        await serverClosed;

        // Initiate cancellation for owned Web response streams, but do not let a user-provided
        // ReadableStream.cancel() that never settles make server cleanup hang indefinitely.
        const responseCleanups = [...activeResponseCleanups];
        activeResponseCleanups.clear();
        for (const cleanup of responseCleanups) void cleanup();

        if (handlerErrors.length > 0) throw handlerErrors[0];
      })();
      return closePromise;
    },
  };
}

export function createRequestSequenceHandler({ handlers }: {
  handlers: readonly MockServerHandler[],
}): MockServerHandler {
  return async ({ request, requestNumber, node }) => {
    const handler = handlers[requestNumber - 1];
    if (handler === undefined) {
      throw new Error(`Unexpected mock server request #${requestNumber}; configured sequence length is ${handlers.length}.`);
    }
    return await handler({ request, requestNumber, node });
  };
}



export function createStreamingResponse({ chunks, init }: {
  chunks: readonly (string | Uint8Array)[],
  init: ResponseInit | undefined,
}): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  }), init);
}

async function handleIncomingRequest({
  incoming,
  response,
  requestNumber,
  handler,
  capturedRequests,
  handlerErrors,
  activeResponseCleanups,
}: {
  incoming: IncomingMessage,
  response: ServerResponse,
  requestNumber: number,
  handler: MockServerHandler,
  capturedRequests: CapturedRequest[],
  handlerErrors: unknown[],
  activeResponseCleanups: Set<() => Promise<void>>,
}): Promise<void> {
  try {
    let rawBody: Uint8Array;
    try {
      rawBody = await readIncomingBody({ incoming });
    } catch (error) {
      // A client that disconnects before sending the complete HTTP request is a transport event,
      // not a fixture handler failure that should make close() reject.
      if (!incoming.complete) {
        if (!response.destroyed) response.destroy();
        return;
      }
      throw error;
    }
    const request = createWebRequest({ incoming, rawBody });
    const capturedRequest = createCapturedRequest({
      requestNumber,
      request: createWebRequest({ incoming, rawBody }),
      rawBody,
    });
    capturedRequests.push(capturedRequest);

    let takenOver = false;
    const result = await handler({
      request,
      requestNumber,
      node: {
        response,
        takeOver() {
          takenOver = true;
          return handledToken;
        },
      },
    });

    if (result === handledToken) {
      if (!takenOver) throw new Error('Mock server handler returned a takeover token without taking over the Node response.');
      return;
    }
    if (takenOver) throw new Error('Mock server handler took over the Node response but returned a Web Response.');

    await writeWebResponse({ response, webResponse: result, activeResponseCleanups });
  } catch (error) {
    handlerErrors.push(error);
    if (!response.destroyed) response.destroy();
  }
}

function createWebRequest({ incoming, rawBody }: {
  incoming: IncomingMessage,
  rawBody: Uint8Array,
}): Request {
  const method = incoming.method ?? 'GET';
  const headers = createWebHeaders({ incomingHeaders: incoming.headers });
  const host = headers.get('host') ?? '127.0.0.1';
  const url = `http://${host}${incoming.url ?? '/'}`;
  const body = method === 'GET' || method === 'HEAD' ? undefined : rawBody.slice();
  return new Request(url, {
    method,
    headers,
    body,
  });
}

function createWebHeaders({ incomingHeaders }: {
  incomingHeaders: IncomingHttpHeaders,
}): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incomingHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

function createCapturedRequest({ requestNumber, request, rawBody }: {
  requestNumber: number,
  request: Request,
  rawBody: Uint8Array,
}): CapturedRequest {
  const stableRawBody = rawBody.slice();
  return {
    requestNumber,
    request,
    rawBody: stableRawBody,
    async text() {
      return new TextDecoder().decode(stableRawBody);
    },
    async json() {
      return JSON.parse(new TextDecoder().decode(stableRawBody)) as unknown;
    },
  };
}

async function readIncomingBody({ incoming }: {
  incoming: IncomingMessage,
}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of incoming) {
    chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function writeWebResponse({ response, webResponse, activeResponseCleanups }: {
  response: ServerResponse,
  webResponse: Response,
  activeResponseCleanups: Set<() => Promise<void>>,
}): Promise<void> {
  const clientClosedError = new Error('Mock server client connection closed while streaming a response.');

  if (webResponse.body === null) {
    if (response.destroyed) return;
    response.statusCode = webResponse.status;
    for (const [name, value] of webResponse.headers) response.setHeader(name, value);
    response.end();
    return;
  }

  if (response.destroyed) {
    void webResponse.body.cancel(clientClosedError).catch(() => undefined);
    return;
  }

  const reader = webResponse.body.getReader();
  let cancellationPromise: Promise<void> | undefined;
  const cancelReader = ({ reason }: { reason: unknown }): Promise<void> => {
    cancellationPromise ??= reader.cancel(reason).catch(() => undefined);
    return cancellationPromise;
  };
  const cleanup = async (): Promise<void> => {
    await cancelReader({ reason: clientClosedError });
  };
  activeResponseCleanups.add(cleanup);
  const cancelOnPrematureClose = () => {
    if (!response.writableEnded) void cleanup();
  };
  response.once('close', cancelOnPrematureClose);

  try {
    if (response.destroyed) {
      await cleanup();
      return;
    }

    response.statusCode = webResponse.status;
    for (const [name, value] of webResponse.headers) response.setHeader(name, value);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (response.destroyed) return;
      if (!response.write(value)) await waitForDrainOrClose({ response });
    }
    if (!response.destroyed) response.end();
  } catch (error) {
    await cancelReader({ reason: error });
    if (response.destroyed) return;
    throw error;
  } finally {
    response.off('close', cancelOnPrematureClose);
    if (response.destroyed && !response.writableEnded) await cleanup();
    activeResponseCleanups.delete(cleanup);
  }
}

async function waitForDrainOrClose({ response }: {
  response: ServerResponse,
}): Promise<void> {
  if (response.destroyed) throw new Error('Mock server client connection closed while streaming a response.');

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Mock server client connection closed while waiting for response backpressure.'));
    };
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Node event listeners receive the emitted Error positionally.
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
  });
}

async function listenOnEphemeralPort({ server }: {
  server: ReturnType<typeof createServer>,
}): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Node event listeners receive the emitted Error positionally.
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Mock server did not receive a TCP address.');
  return `http://127.0.0.1:${address.port}`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
