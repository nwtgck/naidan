import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRemote } from '@/utils/worker-transport';
import type { GenerateInput } from '@/features/llama-cpp-browser/types';
import type { LlamaCppWorkerApi } from './types';
import { createLlamaCppWorkerSessionClient } from './client-session';

const completed = { content: 'text', reasoningContent: '', toolCalls: [], finishReason: 'stop' as const };
const clients: ReturnType<typeof createLlamaCppWorkerSessionClient>[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});
function fixture() {
  const remote = { generate: vi.fn(), cancelGeneration: vi.fn(async () => {}) } as unknown as WorkerRemote<LlamaCppWorkerApi>;
  const client = createLlamaCppWorkerSessionClient({ worker: new EventTarget() as Worker, remote, disposeTransport: () => {}, getAssetBaseURL: () => undefined });
  clients.push(client);
  const input: GenerateInput = { model: 'test.gguf', messages: [{ role: 'user', content: 'hi' }], options: { profile: 'cpu-wasm32' }, temperature: 0, topP: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
  return { client, remote, input };
}
describe('content acknowledgement ends with its client operation', () => {
  it.each(['dispose', 'complete'] as const)('rejects stale content after %s instead of silently acknowledging discarded output', async reason => {
    const { client, remote, input } = fixture();
    const finish = Promise.withResolvers<typeof completed>(); vi.mocked(remote.generate).mockReturnValue(finish.promise);
    const receive = vi.fn();
    const pending = client.generate({ request: input, onEvent: receive, onProgress: () => {}, signal: undefined });
    const result = pending.catch(() => undefined);
    const callback = vi.mocked(remote.generate).mock.calls[0]![1];
    switch (reason) {
    case 'dispose': client.dispose(); break;
    case 'complete': finish.resolve(completed); break;
    default: { const exhaustive: never = reason; throw new Error(`Unknown end: ${exhaustive}`); }
    }
    try {
      await result;
      await expect(callback({ event: { type: 'text', text: 'late' } })).rejects.toThrow('worker-failed');
      expect(receive).not.toHaveBeenCalled();
    } finally {
      finish.resolve(completed);
    }
  });
  it('rejects an acknowledgement if the client closes while asynchronous delivery is pending', async () => {
    const { client, remote, input } = fixture();
    const finish = Promise.withResolvers<typeof completed>(); const delivery = Promise.withResolvers<void>();
    vi.mocked(remote.generate).mockReturnValue(finish.promise);
    const receive = vi.fn(async () => delivery.promise);
    const pending = client.generate({ request: input, onEvent: receive, onProgress: () => {}, signal: undefined });
    const failed = expect(pending).rejects.toThrow('worker-failed');
    const callback = vi.mocked(remote.generate).mock.calls[0]![1];
    const acknowledgement = callback({ event: { type: 'text', text: 'in flight' } });
    try {
      expect(receive).toHaveBeenCalledOnce(); client.dispose(); await failed;
      delivery.resolve();
      await expect(acknowledgement).rejects.toThrow('worker-failed');
    } finally {
      delivery.resolve(); finish.resolve(completed);
    }
  });
});
