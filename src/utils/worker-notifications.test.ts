// @vitest-environment node
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { Endpoint } from 'comlink';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { postWorkerNotification, subscribeWorkerNotifications } from './worker-transport';
const schema = z.object({ type: z.literal('notification-test'), count: z.number().int().nonnegative().max(8) }).strict();
function endpoint({ port }: { port: MessagePort }): Endpoint {
  return port as unknown as Endpoint;
}
it('sends one-way notifications over real ports, validates both boundaries and stops on unsubscribe', async () => {
  const { port1, port2 } = new MessageChannel();
  const listen = vi.fn(); const messages = vi.fn(); port1.on('message', messages);
  const unsubscribe = subscribeWorkerNotifications({ endpoint: endpoint({ port: port2 }), schema, listener: listen });
  try {
    postWorkerNotification({ endpoint: endpoint({ port: port1 }), schema, value: { type: 'notification-test', count: 3 } });
    postWorkerNotification({ endpoint: endpoint({ port: port1 }), schema, value: { type: 'notification-test', count: 20 } });
    port1.postMessage({ type: 'notification-test', count: 9 });
    await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce());
    expect(listen).toHaveBeenCalledWith({ value: { type: 'notification-test', count: 3 } });
    expect(messages).not.toHaveBeenCalled(); // No acknowledgement promise/messages.
    unsubscribe(); postWorkerNotification({ endpoint: endpoint({ port: port1 }), schema, value: { type: 'notification-test', count: 2 } });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(listen).toHaveBeenCalledOnce();
  } finally {
    unsubscribe(); port1.close(); port2.close();
  }
});
it('does not propagate validation or delivery exceptions through a native log callback', () => {
  const endpoint = { postMessage: vi.fn(() => {
    throw new Error('detached receiver');
  }) };
  expect(() => postWorkerNotification({ endpoint, schema, value: { type: 'notification-test', count: 1 } })).not.toThrow();
  expect(endpoint.postMessage).toHaveBeenCalledOnce();
});
