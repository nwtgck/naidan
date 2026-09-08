// @vitest-environment node
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { expose, releaseProxy, type Remote, type Endpoint } from 'comlink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressInfo } from '@/features/transformers-js/types';
import type { ToolCall } from '@/01-models/types';
import { createTransformersJsWorkerClient } from './client-hosted';
import { createDownloadVerificationCandidateAcceptanceWorkerClient } from '@/features/transformers-js/download-verification/candidate-acceptance-worker/client-hosted';

const ready = { channel: 'naidan-production-worker-startup', version: 1, status: 'ready' };
const workers: TransportWorker[] = [];
const clients: Array<{ dispose(): Promise<void> }> = [];
const forbiddenFetch = vi.fn(() => {
  throw new Error('Unexpected network request');
});

beforeEach(() => {
  forbiddenFetch.mockClear();
  vi.stubGlobal('fetch', forbiddenFetch);
});

// A started MessagePort models the dispatch-enabled bootstrap gap, not browser
// Worker scheduling. Comlink and both transferred callback ports are real.
class TransportWorker extends EventTarget {
  readonly channel = new MessageChannel();
  // The fixture transfers only Node MessagePorts, never browser-only objects.
  // Node's transfer-list type is narrower than Comlink's DOM declaration.
  readonly endpoint = this.channel.port2 as unknown as Endpoint;
  readonly sent: unknown[] = [];
  terminate = vi.fn(() => {
    this.channel.port1.close();
    this.channel.port2.close();
  });

  constructor() {
    super();
    this.channel.port1.on('message', data => this.dispatchEvent(new MessageEvent('message', { data })));
    this.channel.port2.start();
    workers.push(this);
  }

  postMessage(message: unknown, transfer: Parameters<MessagePort['postMessage']>[1]) {
    this.sent.push(message);
    this.channel.port1.postMessage(message, transfer);
  }

  publishReady() {
    this.dispatchEvent(new MessageEvent('message', { data: ready }));
  }
}

function currentWorker(): TransportWorker {
  const worker = workers.at(-1);
  if (!worker) throw new Error('No Worker was constructed');
  return worker;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.dispose();
  for (const worker of workers.splice(0)) {
    worker.channel.port1.close();
    worker.channel.port2.close();
  }
  vi.unstubAllGlobals();
  expect(forbiddenFetch).not.toHaveBeenCalled();
});

describe('Production startup through real Comlink transport', () => {
  it('sends no ordinary Load RPC until delayed expose has completed', async () => {
    vi.stubGlobal('Worker', TransportWorker);
    const client = createTransformersJsWorkerClient();
    clients.push(client);
    const result = client.loadDownloadedModel({ modelId: 'public/model', progressCallback: vi.fn() });
    void result.catch(() => undefined);
    const worker = currentWorker();
    expect(worker.sent).toHaveLength(0);

    const api = {
      device: 'webgpu',
      async loadDownloadedModel() {
        return { device: this.device, dtype: 'q4' };
      },
    };
    expose(api, worker.endpoint);
    worker.publishReady();
    await expect(result).resolves.toEqual({ device: 'webgpu', dtype: 'q4' });
  });

  it('rejects a pending startup on Worker error instead of waiting for an RPC reply', async () => {
    vi.stubGlobal('Worker', TransportWorker);
    const client = createTransformersJsWorkerClient();
    clients.push(client);
    const result = client.unloadModel();
    let failure: unknown;
    void result.catch(error => {
      failure = error;
    });
    const worker = currentWorker();
    worker.dispatchEvent(new Event('error'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(failure).toBeInstanceOf(Error);
    expect(worker.sent).toHaveLength(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('rejects stop before ready and never sends the delayed candidate RPC', async () => {
    vi.stubGlobal('Worker', TransportWorker);
    const client = createDownloadVerificationCandidateAcceptanceWorkerClient();
    clients.push(client);
    const result = client.verifyDownloadedModelCandidate({
      modelId: 'public/model', loadRevision: 'exact',
      candidate: { device: 'webgpu', dtype: 'q4' }, progressCallback: vi.fn(),
    });
    let failure: unknown;
    void result.catch(error => {
      failure = error;
    });
    const worker = currentWorker();
    await client.dispose();
    worker.publishReady();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(failure).toBeInstanceOf(Error);
    expect(worker.sent).toHaveLength(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('replays the candidate revision RPC after expose and delivers its real proxy callback', async () => {
    vi.stubGlobal('Worker', TransportWorker);
    const client = createDownloadVerificationCandidateAcceptanceWorkerClient();
    clients.push(client);
    const progress = vi.fn();
    const result = client.verifyDownloadedModelRevision({
      modelId: 'public/model', loadRevision: 'exact', progressCallback: progress,
    });
    const worker = currentWorker();
    expect(worker.sent).toHaveLength(0);
    expose({
      async verifyDownloadedModelRevision(modelId: string, revision: string, callback: Remote<(info: ProgressInfo) => void>) {
        expect([modelId, revision]).toEqual(['public/model', 'exact']);
        await callback({ status: 'cache-acceptance-config' });
        callback[releaseProxy]();
        return { device: 'webgpu', dtype: 'q4' };
      },
    }, worker.endpoint);
    worker.publishReady();
    await expect(result).resolves.toEqual({ device: 'webgpu', dtype: 'q4' });
    expect(progress).toHaveBeenCalledWith({ info: { status: 'cache-acceptance-config' } });
  });

  it.each(['error', 'messageerror', 'dispose'] as const)('terminates an active candidate on %s and drops late callbacks', async event => {
    vi.stubGlobal('Worker', TransportWorker);
    const client = createDownloadVerificationCandidateAcceptanceWorkerClient();
    clients.push(client);
    const progress = vi.fn();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<{ device: string, dtype: string }>();
    let callback: Remote<(info: ProgressInfo) => void> | undefined;
    const worker = currentWorker();
    expose({
      async verifyDownloadedModelCandidate(_model: string, _revision: string, _candidate: unknown, value: Remote<(info: ProgressInfo) => void>) {
        callback = value;
        await callback({ status: 'cache-acceptance-config' });
        entered.resolve();
        return await finish.promise;
      },
    }, worker.endpoint);
    worker.publishReady();
    const result = client.verifyDownloadedModelCandidate({
      modelId: 'public/model', loadRevision: 'exact',
      candidate: { device: 'webgpu', dtype: 'q4' }, progressCallback: progress,
    });
    const rejected = expect(result).rejects.toMatchObject({ name: 'ProductionWorkerLifecycleError' });
    await entered.promise;
    expect(progress).toHaveBeenCalledOnce();
    switch (event) {
    case 'dispose': await client.dispose(); break;
    case 'error':
    case 'messageerror': worker.dispatchEvent(new Event(event)); break;
    default: {
      const _ex: never = event;
      throw new Error(`Unhandled test event: ${_ex}`);
    }
    }
    await rejected;
    if (!callback) throw new Error('Candidate never received its progress callback');
    // This separate callback port can deliver after the main endpoint terminates.
    await callback({ status: 'cache-acceptance-ready' });
    expect(progress).toHaveBeenCalledOnce();
    callback[releaseProxy]();
    finish.resolve({ device: 'webgpu', dtype: 'q4' });
    await client.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.sent).toHaveLength(1); // No advisory RELEASE while an RPC is active.
  });

  it('preserves awaited tool callback promises across real Comlink and drops late generation callbacks', async () => {
    vi.stubGlobal('Worker', TransportWorker);
    const client = createTransformersJsWorkerClient();
    clients.push(client);
    const worker = currentWorker();
    const toolEntered = Promise.withResolvers<void>();
    const toolFinished = Promise.withResolvers<void>();
    const afterTool = vi.fn();
    const onChunk = vi.fn();
    const onToolCalls = vi.fn(async () => {
      toolEntered.resolve();
      await toolFinished.promise;
    });
    let chunkCallback: Remote<(chunk: string) => void> | undefined;
    let toolCallback: Remote<(calls: ToolCall[]) => void> | undefined;
    expose({
      async generateText(_messages: unknown, chunk: Remote<(chunk: string) => void>, tools: Remote<(calls: ToolCall[]) => void>) {
        chunkCallback = chunk;
        toolCallback = tools;
        await chunk('first');
        await tools([]);
        afterTool();
      },
      async interrupt() {},
    }, worker.endpoint);
    worker.publishReady();
    const result = client.generateText({ messages: [], onChunk, onToolCalls });
    await toolEntered.promise;
    // A second real RPC/response crosses the Worker endpoint while the tool
    // callback promise is held. It is not a sleep-based completion guess.
    await client.interrupt();
    expect(afterTool).not.toHaveBeenCalled();
    toolFinished.resolve();
    await result;
    expect(afterTool).toHaveBeenCalledOnce();
    await client.dispose();
    if (!chunkCallback || !toolCallback) throw new Error('Missing transferred generation callbacks');
    await chunkCallback('late');
    await toolCallback([]);
    expect(onChunk).toHaveBeenCalledExactlyOnceWith({ chunk: 'first' });
    expect(onToolCalls).toHaveBeenCalledOnce();
    chunkCallback[releaseProxy]();
    toolCallback[releaseProxy]();
  });
});
