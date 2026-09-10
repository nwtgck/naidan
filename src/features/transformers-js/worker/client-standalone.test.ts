import { describe, expect, it, vi } from 'vitest';
import { createTransformersJsGenerationCaptureClient, createTransformersJsWorkerClient } from './client-standalone';

describe('standalone Production client boundary', () => {
  it('rejects investigation capture without reading its active request or creating a Worker', () => {
    const getActiveRequest = vi.fn(() => undefined);
    expect(() => createTransformersJsGenerationCaptureClient({ runId: 'run-1', workerEpoch: 1, getActiveRequest,
      limits: { maxCalls: 32, maxInvocationsPerCall: 8, maxEvents: 4096, maxTextBytes: 262144, maxTensorBytes: 16777216, maxTotalTensorBytes: 67108864, maxTokensPerStreamEvent: 65536, maxTotalStreamTokens: 262144, maxTotalStreamTokenBytes: 8388608 },
    })).toThrow('Transformers.js is not available in standalone mode');
    expect(getActiveRequest).not.toHaveBeenCalled();
  });

  it('preserves ordinary unavailable Load and harmless disposal', async () => {
    const client = createTransformersJsWorkerClient();
    await expect(client.loadDownloadedModel({ modelId: 'org/model', progressCallback: vi.fn() })).rejects.toThrow('Transformers.js is not available in standalone mode');
    await client.dispose();
  });
});
