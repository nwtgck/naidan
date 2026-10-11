import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';

type Waiting = { sender: { response: ServerResponse, bytes: Buffer, complete: boolean } | undefined, receiver: ServerResponse | undefined };

/** A deliberately small test relay, not an implementation of Piping Server.
 * Real loopback sockets and fetch carry the production encrypted protocol;
 * only the HTTP rendezvous/occupancy behavior needed by these tests is modeled. */
export async function createHttpRelay() {
  const waiting = new Map<string, Waiting>();
  const frames: Buffer[] = [];
  let dropped = 0, dropNext = false, requests = 0, rejected = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.headers['x-relay-test'] !== 'authorized') {
      rejected++; response.writeHead(403).end(); request.resume(); return;
    }
    const route = request.url;
    if (!route || !/^\/[A-Za-z0-9_-]{1,96}$/.test(route) || request.method !== 'GET' && request.method !== 'POST') {
      response.writeHead(400).end(); request.resume(); return;
    }
    const slot = waiting.get(route) ?? { sender: undefined, receiver: undefined };
    waiting.set(route, slot);
    const cleanup = () => {
      if (slot.sender?.response === response) slot.sender = undefined;
      if (slot.receiver === response) slot.receiver = undefined;
      if (!slot.sender && !slot.receiver && waiting.get(route) === slot) waiting.delete(route);
    };
    response.on('close', cleanup);
    request.on('error', () => response.destroy());
    const deliver = () => {
      if (!slot.sender?.complete || !slot.receiver) return;
      const sender = slot.sender, receiver = slot.receiver;
      slot.sender = undefined; slot.receiver = undefined;
      if (waiting.get(route) === slot) waiting.delete(route);
      frames.push(sender.bytes);
      receiver.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      // Deliberately fragment the HTTP payload without changing RPC framing.
      for (let at = 0; at < sender.bytes.length; at += 113) receiver.write(sender.bytes.subarray(at, at + 113));
      receiver.end();
      if (dropNext) {
        dropNext = false; dropped++; sender.response.destroy();
      } else sender.response.writeHead(200).end('Sent.');
    };
    switch (request.method) {
    case 'GET':
      if (slot.receiver) {
        response.writeHead(400).end('[ERROR] The number of receivers has reached limits.'); return;
      }
      slot.receiver = response; deliver(); break;
    case 'POST': {
      if (slot.sender) {
        response.writeHead(400).end(`[ERROR] Another sender has been connected on '${route}'.`); request.resume(); return;
      }
      // Install a placeholder while the request body is arriving, so duplicate
      // POSTs never overwrite an already waiting sender.
      const sender = { response, bytes: Buffer.alloc(0), complete: false }; slot.sender = sender;
      const chunks: Buffer[] = []; let size = 0;
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65536) {
          response.writeHead(413).end(); request.destroy(); return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        if (response.destroyed || slot.sender !== sender) return;
        sender.bytes = Buffer.concat(chunks); sender.complete = true;
        deliver();
      });
      break;
    }
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject); resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stats: () => ({ requests, dropped, rejected, waiting: waiting.size, frames }),
    dropNextAcknowledgement() {
      dropNext = true;
    },
    async close(): Promise<void> {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed; waiting.clear();
    },
  };
}

export const TEST_ONLY = {
};
