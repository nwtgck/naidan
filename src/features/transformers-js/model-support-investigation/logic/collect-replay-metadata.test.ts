// @vitest-environment node
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyReplayMetadataAccess, collectReplayMetadata, REPLAY_METADATA_FILE_BYTES, REPLAY_METADATA_TARGET_BYTES, REPLAY_METADATA_BATCH_BYTES, REPLAY_METADATA_PATHS, replayMetadataSummarySchema, validateReplayMetadataContent, type InvestigationReplayMetadataSnapshot } from '@/features/transformers-js/model-support-investigation/logic/collect-replay-metadata';
import { createBatchModelSupportEvidence } from '@/features/transformers-js/model-support-investigation/logic/create-partial-evidence';
import { createInitialInvestigationCheckpoint } from '@/features/transformers-js/model-support-investigation/logic/investigation-recovery';
import { createModelSupportInvestigationEvidenceWorker } from '@/features/transformers-js/model-support-investigation/evidence-worker/impl';
import { createModelSupportInvestigationEvidenceWorkerRequest } from '@/features/transformers-js/model-support-investigation/evidence-worker/request';
import { createModelSupportInvestigationBatchEvidenceWorkerRequest } from '@/features/transformers-js/model-support-investigation/evidence-worker/batch-request';
import { addReplayMetadataToEvidenceFiles } from '@/features/transformers-js/model-support-investigation/logic/replay-metadata-export';

const revision = 'a'.repeat(40);
const modelId = 'public/model';
const metadata = '{ "model_type": "qwen3_5", "eos_token_id": 3 }';
const bytes = new TextEncoder().encode(metadata);
const forbiddenFetch = vi.fn(() => {
  throw new Error('Unexpected external fetch');
});
afterEach(() => {
  expect(forbiddenFetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.useRealTimers();
});

function options({ remoteFetch }: { remoteFetch: typeof fetch | undefined }): Parameters<typeof collectReplayMetadata>[0] {
  vi.stubGlobal('fetch', forbiddenFetch);
  return {
    modelId, revision,
    files: [{ path: 'config.json', size: bytes.byteLength }],
    budgetBytes: REPLAY_METADATA_TARGET_BYTES, fileTimeoutMs: 1000, modelAccess: 'public-request',
    localRead: async () => undefined,
    remoteFetch,
    onSnapshot: () => undefined,
  };
}

describe('bounded replay metadata collection', () => {
  it('requires explicit validated public/non-gated repository evidence rather than a local exact path', () => {
    expect(classifyReplayMetadataAccess({ metadata: { private: false, gated: false } })).toBe('public-request');
    expect(classifyReplayMetadataAccess({ metadata: { private: true, gated: false } })).toBe('excluded-private-or-gated');
    expect(classifyReplayMetadataAccess({ metadata: { private: false, gated: 'auto' } })).toBe('excluded-private-or-gated');
    for (const metadata of [undefined, {}, { private: false }, { private: 'false', gated: false }]) expect(classifyReplayMetadataAccess({ metadata })).toBe('unverified');
  });
  it('retains exact raw bytes and checkpoints completed sidecars without adding bytes to summary JSON', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(bytes));
    const snapshots: InvestigationReplayMetadataSnapshot[] = [];
    const result = await collectReplayMetadata({ ...options({ remoteFetch: transport }), onSnapshot: ({ snapshot }) => snapshots.push(snapshot) });
    expect(result.summary.status).toBe('complete');
    expect(result.summary.receivedBytes).toBe(bytes.byteLength);
    expect(result.summary.retainedBytes).toBe(bytes.byteLength);
    expect(await result.sidecars[0]!.blob.text()).toBe(metadata);
    expect(JSON.stringify(result.summary)).not.toContain('eos_token_id');
    expect(snapshots[1]!.sidecars).toHaveLength(1);
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]![0]).toBe(`https://huggingface.co/${modelId}/resolve/${revision}/config.json`);
    expect(transport.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it('reuses exact completed local metadata with zero remote calls', async () => {
    const transport = vi.fn<typeof fetch>();
    const localRead = vi.fn(async () => {
      const blob = new Blob([bytes]);
      Object.defineProperty(blob, 'stream', { value: () => new Response(bytes).body! });
      return blob;
    });
    const result = await collectReplayMetadata({ ...options({ remoteFetch: transport }), localRead });
    expect(result.summary.files[0]).toMatchObject({ status: 'collected', source: 'local-exact' });
    expect(localRead).toHaveBeenCalledWith({ path: 'config.json', revision });
    expect(transport).not.toHaveBeenCalled();
  });

  it('records offline local misses, I/O failure, and unverified revision without fallback', async () => {
    const missing = await collectReplayMetadata(options({ remoteFetch: undefined }));
    expect(missing.summary.files[0]!.status).toBe('local-missing');
    const broken = await collectReplayMetadata({ ...options({ remoteFetch: undefined }), localRead: async () => {
      throw new DOMException('secret path', 'NotReadableError');
    } });
    expect(broken.summary.files[0]!.status).toBe('read-failure');
    const localRead = vi.fn();
    const unverified = await collectReplayMetadata({ ...options({ remoteFetch: undefined }), revision: undefined, localRead });
    expect(unverified.summary.files.every(file => file.status === 'unverified-revision')).toBe(true);
    expect(localRead).not.toHaveBeenCalled();
    expect(JSON.stringify(broken.summary)).not.toContain('secret path');
  });

  it('excludes known private/gated metadata even if a local file is available', async () => {
    const localRead = vi.fn(async () => new Blob([bytes]));
    const remoteFetch = vi.fn<typeof fetch>();
    const result = await collectReplayMetadata({ ...options({ remoteFetch }), localRead, modelAccess: 'excluded-private-or-gated' });
    expect(result.summary.files.every(file => file.status === 'privacy-excluded')).toBe(true);
    expect(localRead).not.toHaveBeenCalled();
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it('does not read raw local metadata when public access is unverified', async () => {
    const localRead = vi.fn(async () => new Blob([bytes]));
    const result = await collectReplayMetadata({ ...options({ remoteFetch: undefined }), localRead, modelAccess: 'unverified' });
    expect(result.summary.files.every(file => file.status === 'access-unverified')).toBe(true);
    expect(localRead).not.toHaveBeenCalled();
    expect(result.sidecars).toHaveLength(0);
  });

  it.each([403, 404, 500])('records HTTP %i as failure, never optional absence, and cancels unread response', async status => {
    const cancel = vi.fn();
    const result = await collectReplayMetadata(options({ remoteFetch: async () => new Response(new ReadableStream({ cancel }), { status }) }));
    expect(result.summary.files[0]).toMatchObject({ status: 'http-failure', httpStatus: status });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects a partial resource labelled HTTP 200 before retaining raw replay bytes', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
      cancel,
    }), { status: 200, headers: { 'Content-Length': String(bytes.byteLength), 'Content-Range': `bytes 0-${bytes.byteLength - 1}/100` } });
    const result = await collectReplayMetadata(options({ remoteFetch: async () => response }));
    expect(result.summary.files[0]).toMatchObject({ status: 'http-failure', httpStatus: 200 });
    expect(result.sidecars).toEqual([]);
    expect(result.summary.receivedBytes).toBe(0);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not fetch unknown/weight paths or pretend not-listed is a runtime optional decision', async () => {
    const remoteFetch = vi.fn<typeof fetch>();
    const result = await collectReplayMetadata({ ...options({ remoteFetch }), files: [{ path: 'onnx/model.onnx', size: 2 }] });
    expect(result.summary.files.every(file => file.status === 'not-listed')).toBe(true);
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it('rejects listed/local oversized metadata before reading any bytes', async () => {
    const localRead = vi.fn(async () => new Blob([bytes]));
    const hugeListing = await collectReplayMetadata({ ...options({ remoteFetch: undefined }), files: [{ path: 'config.json', size: REPLAY_METADATA_FILE_BYTES + 1 }], localRead });
    expect(hugeListing.summary.files[0]!.status).toBe('budget-exceeded');
    expect(localRead).not.toHaveBeenCalled();
    const stream = vi.fn();
    const hugeLocal = new Blob([bytes]);
    Object.defineProperty(hugeLocal, 'size', { value: REPLAY_METADATA_FILE_BYTES + 1 });
    Object.defineProperty(hugeLocal, 'stream', { value: stream });
    const local = await collectReplayMetadata({ ...options({ remoteFetch: undefined }), localRead: async () => hugeLocal });
    expect(local.summary.files[0]!.status).toBe('budget-exceeded');
    expect(stream).not.toHaveBeenCalled();
  });

  it('bounds unknown-length streaming and accounts rejected chunks before stopping the next file', async () => {
    const cancel = vi.fn();
    const remoteFetch = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(11));
    }, cancel })));
    const result = await collectReplayMetadata({ ...options({ remoteFetch }), budgetBytes: 10, files: [{ path: 'config.json', size: undefined }, { path: 'tokenizer.json', size: undefined }] });
    expect(result.summary.receivedBytes).toBe(11);
    expect(result.summary.retainedBytes).toBe(0);
    expect(result.summary.files[0]!.status).toBe('budget-exceeded');
    expect(remoteFetch).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('preserves completed bytes when the next stream hangs and ignores late completion', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const remoteFetch = vi.fn<typeof fetch>(async input => String(input).endsWith('/config.json') ? new Response(bytes) : new Response(new ReadableStream({ cancel })));
    const collected = Promise.withResolvers<void>();
    const pending = collectReplayMetadata({ ...options({ remoteFetch }), fileTimeoutMs: 10, files: [{ path: 'config.json', size: bytes.length }, { path: 'tokenizer.json', size: undefined }], onSnapshot: ({ snapshot }) => {
      if (snapshot.sidecars.length === 1) collected.resolve();
    } });
    await collected.promise;
    await vi.advanceTimersByTimeAsync(30);
    const result = await pending;
    expect(result.summary.files.find(file => file.path === 'tokenizer.json')!.status).toBe('timeout');
    expect(result.sidecars).toHaveLength(1);
    expect(result.summary.retainedBytes).toBe(bytes.length);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['{"eos_token_id":3,"tokenizer_class":"Test"}', 'collected'],
    ['{"access_token":"private"}', 'privacy-excluded'],
    ['{"note":"Bearer abcdefghijklmnopqrstuvwxyz"}', 'privacy-excluded'],
    ['<html>private server error</html>', 'invalid-content'],
  ])('checks public metadata content without generic token-key redaction: %s', async (text, status) => {
    const result = await collectReplayMetadata({ ...options({ remoteFetch: async () => new Response(text) }), files: [{ path: 'config.json', size: undefined }] });
    expect(result.summary.files[0]!.status).toBe(status);
    expect(result.sidecars).toHaveLength(status === 'collected' ? 1 : 0);
  });

  it('keeps current corpus tokenizer sizes below the file budget', () => {
    for (const size of [19439251, 27868174, 17905598, 19226111, 2104556]) expect(size).toBeLessThan(REPLAY_METADATA_FILE_BYTES);
    expect(() => validateReplayMetadataContent({ path: 'weights.onnx', bytes })).toThrow();
  });

  it('preserves credential-like vocabulary and added tokens while rejecting actual secret objects', () => {
    const tokenizer = { model: { type: 'BPE', vocab: { password: 0, cookie: 1, authorization: 2, api_key: 3, hf_abcdefghijklmnopqrstuv: 4 } }, added_tokens: [{ id: 5, content: 'Bearer abcdefghijklmnopqrstuvwxyz', special: true }] };
    expect(() => validateReplayMetadataContent({ path: 'tokenizer.json', bytes: new TextEncoder().encode(JSON.stringify(tokenizer)) })).not.toThrow();
    expect(() => validateReplayMetadataContent({ path: 'tokenizer.json', bytes: new TextEncoder().encode(JSON.stringify({ ...tokenizer, credentials: { access_token: 'secret' } })) })).toThrow('privacy-excluded');
    expect(() => validateReplayMetadataContent({ path: 'tokenizer.json', bytes: new TextEncoder().encode(JSON.stringify({ model: { vocab: { password: { api_key: 'secret' } } } })) })).toThrow('invalid-content');
  });
});

describe('replay metadata Evidence integration', () => {
  it('rejects forged aggregate budgets and inconsistent collected summaries before reading sidecars', async () => {
    const snapshot = await collectReplayMetadata(options({ remoteFetch: async () => new Response(bytes) }));
    expect(replayMetadataSummarySchema.safeParse({ ...snapshot.summary, retainedBytes: bytes.length + 1 }).success).toBe(false);
    expect(replayMetadataSummarySchema.safeParse({ ...snapshot.summary, files: [snapshot.summary.files[0], snapshot.summary.files[0]] }).success).toBe(false);
    const total = REPLAY_METADATA_FILE_BYTES * REPLAY_METADATA_PATHS.length;
    const forged = { ...snapshot.summary, receivedBytes: total, retainedBytes: total, files: REPLAY_METADATA_PATHS.map(path => ({ path, status: 'collected', source: 'remote-exact', byteLength: REPLAY_METADATA_FILE_BYTES, sha256: 'a'.repeat(64) })) };
    await expect(addReplayMetadataToEvidenceFiles({ files: new Map(), summary: forged, sidecars: undefined })).rejects.toThrow();
    const large = new Blob(['{}']);
    Object.defineProperty(large, 'size', { value: REPLAY_METADATA_BATCH_BYTES + 1 });
    const read = vi.fn();
    Object.defineProperty(large, 'arrayBuffer', { value: read });
    const { run, recovery } = createInitialInvestigationCheckpoint({ modelId, runId: 'budget-run', now: () => '2026-09-08T00:00:00.000Z' });
    await expect(createBatchModelSupportEvidence({ batchId: 'budget', items: [{ target: modelId, status: 'passed', run, recovery, error: undefined, replayMetadata: [{ path: 'config.json', blob: large }] }] })).rejects.toThrow('byte budget');
    expect(read).not.toHaveBeenCalled();
  });
  it('exports and reexports raw bytes in single/batch Worker archives but never in run JSON', async () => {
    const snapshot = await collectReplayMetadata(options({ remoteFetch: async () => new Response(bytes) }));
    const { run, recovery } = createInitialInvestigationCheckpoint({ modelId, runId: 'replay-run', now: () => '2026-09-08T00:00:00.000Z' });
    run.replayMetadata = snapshot.summary;
    const worker = createModelSupportInvestigationEvidenceWorker();
    const request = createModelSupportInvestigationEvidenceWorkerRequest({ run, recovery });
    expect(await request.text()).not.toContain('eos_token_id');
    for (let index = 0; index < 2; index++) {
      const archive = await worker.createPartialEvidence({ request, replayMetadata: snapshot.sidecars });
      const zip = await JSZip.loadAsync(await archive.blob.arrayBuffer());
      expect(await zip.file('replay-metadata/files/config.json')!.async('string')).toBe(metadata);
      expect(await zip.file('run.json')!.async('string')).not.toContain('eos_token_id');
    }
    const items = [{ target: modelId, status: 'interrupted' as const, run, recovery, error: undefined, replayMetadata: snapshot.sidecars }];
    const batchRequest = createModelSupportInvestigationBatchEvidenceWorkerRequest({ batchId: 'replay-batch', items });
    expect(await batchRequest.text()).not.toContain('"blob"');
    const batch = await worker.createBatchEvidence({ request: batchRequest, replayMetadata: [snapshot.sidecars] });
    const zip = await JSZip.loadAsync(await batch.blob.arrayBuffer());
    expect(Object.keys(zip.files).filter(path => path.endsWith('/replay-metadata/files/config.json'))).toHaveLength(1);
  });

  it('rejects forged bytes/paths, and labels missing sidecars rather than claiming archived replayability', async () => {
    const snapshot = await collectReplayMetadata(options({ remoteFetch: async () => new Response(bytes) }));
    await expect(addReplayMetadataToEvidenceFiles({ files: new Map(), summary: snapshot.summary, sidecars: [{ path: '../secret', blob: new Blob([bytes]) }] })).rejects.toThrow();
    await expect(addReplayMetadataToEvidenceFiles({ files: new Map(), summary: snapshot.summary, sidecars: [{ path: 'config.json', blob: new Blob(['x'.repeat(bytes.length)]) }] })).rejects.toThrow();
    const files = new Map<string, Blob>();
    await addReplayMetadataToEvidenceFiles({ files, summary: snapshot.summary, sidecars: undefined });
    const index = JSON.parse(await files.get('replay-metadata/index.json')!.text());
    expect(index.files[0].archived).toBe(false);
  });
});
