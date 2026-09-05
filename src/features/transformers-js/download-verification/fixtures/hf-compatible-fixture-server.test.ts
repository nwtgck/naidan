import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createHuggingFaceFixtureServer,
  type HuggingFaceFixtureServer,
  type HuggingFaceRepositoryFixture,
} from '@/features/transformers-js/download-verification/fixtures/hf-compatible-fixture-server';
import { runBrowserDownloadVerification } from '@/features/transformers-js/download-verification/logic/run-browser-download-verification';

const openServers: HuggingFaceFixtureServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async server => await server.close()));
});

function readRepositoryFixture({ name }: { name: string }): HuggingFaceRepositoryFixture {
  const path = resolve(
    process.cwd(),
    'src/features/transformers-js/download-verification/fixtures/repositories',
    `${name}.json`,
  );
  return JSON.parse(readFileSync(path, 'utf8')) as HuggingFaceRepositoryFixture;
}

describe('Hugging Face-compatible Download Verification fixture server', () => {
  it('exercises real fetch redirect and HEAD without transferring a large model body', async () => {
    const repository = readRepositoryFixture({ name: 'qwen3-5-2b' });
    const server = await createHuggingFaceFixtureServer({ repository });
    openServers.push(server);

    const run = await runBrowserDownloadVerification({
      modelId: repository.modelId,
      remoteBaseUrl: server.baseUrl,
      maximumProbedArtifacts: 2,
    });

    expect(run.resolvedRevision).toBe(repository.resolvedRevision);
    expect(run.bytesConsumed).toBe(0);
    expect(run.transportObservations).toHaveLength(2);
    for (const observation of run.transportObservations) {
      expect(observation).toMatchObject({
        method: 'HEAD',
        status: 200,
        redirected: true,
        rangeHonored: undefined,
        bytesConsumed: 0,
      });
      expect(observation.finalOrigin).toBe(server.baseUrl);
      expect(observation.finalUrl).not.toContain('X-Amz-Signature');
      expect(observation.acceptRanges).toBe('bytes');
    }

    const qwenExternalData = run.repositoryFiles.find(file => file.path === 'onnx/decoder_model_merged_q4f16.onnx_data');
    expect(qwenExternalData).toMatchObject({
      lfsSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      lfsSize: 1_089_777_664,
    });
  });

  it('serves bounded Range bodies and refuses an unbounded artifact GET', async () => {
    const repository = readRepositoryFixture({ name: 'smollm2-135m-instruct' });
    const server = await createHuggingFaceFixtureServer({ repository });
    openServers.push(server);
    const file = repository.files.find(candidate => candidate.path === 'onnx/model_q4f16.onnx');
    expect(file).toBeDefined();

    const encodedPath = file?.path.split('/').map(part => encodeURIComponent(part)).join('/') ?? '';
    const resolveUrl = `${server.baseUrl}/${repository.modelId}/resolve/${repository.resolvedRevision}/${encodedPath}`;

    const bounded = await fetch(resolveUrl, {
      headers: { Range: 'bytes=0-4095' },
      redirect: 'follow',
    });
    expect(bounded.status).toBe(206);
    expect(bounded.headers.get('content-range')).toBe(`bytes 0-4095/${file?.size}`);
    expect((await bounded.arrayBuffer()).byteLength).toBe(4096);

    const unbounded = await fetch(resolveUrl, { redirect: 'follow' });
    expect(unbounded.status).toBe(416);
    expect((await unbounded.arrayBuffer()).byteLength).toBe(0);
  });
});

describe('Hugging Face-compatible fixture failure matrix', () => {
  it('exercises a server that ignores Range without allowing an unbounded transfer', async () => {
    const repository = readRepositoryFixture({ name: 'smollm2-135m-instruct' });
    const server = await createHuggingFaceFixtureServer({
      repository,
      behavior: {
        head: 'insufficient',
        range: 'ignore',
        ignoredRangeBodyBytes: 96 * 1024,
      },
    });
    openServers.push(server);

    const run = await runBrowserDownloadVerification({
      modelId: repository.modelId,
      remoteBaseUrl: server.baseUrl,
      maximumProbedArtifacts: 1,
      perFileByteBudget: 64 * 1024,
      totalByteBudget: 64 * 1024,
    });

    expect(run.transportObservations[0]).toMatchObject({
      method: 'GET-range',
      status: 200,
      rangeHonored: false,
      abortedByByteBudget: true,
      error: undefined,
    });
    expect(run.bytesConsumed).toBeGreaterThanOrEqual(64 * 1024);
    expect(run.bytesConsumed).toBeLessThanOrEqual(96 * 1024);
  });

  it('records an artifact 404 after an inconclusive HEAD without consuming body bytes', async () => {
    const repository = readRepositoryFixture({ name: 'smollm2-135m-instruct' });
    const server = await createHuggingFaceFixtureServer({
      repository,
      behavior: { head: 'not-found', range: 'not-found' },
    });
    openServers.push(server);

    const run = await runBrowserDownloadVerification({
      modelId: repository.modelId,
      remoteBaseUrl: server.baseUrl,
      maximumProbedArtifacts: 1,
    });

    expect(run.bytesConsumed).toBe(0);
    expect(run.transportObservations[0]).toMatchObject({
      method: 'GET-range',
      status: 404,
      rangeHonored: false,
      bytesConsumed: 0,
      error: undefined,
    });
  });

  it('preserves bytes received before the fixture server disconnects a Range response', async () => {
    const repository = readRepositoryFixture({ name: 'smollm2-135m-instruct' });
    const server = await createHuggingFaceFixtureServer({
      repository,
      behavior: {
        head: 'insufficient',
        range: 'disconnect',
        disconnectAfterBytes: 2048,
      },
    });
    openServers.push(server);

    const run = await runBrowserDownloadVerification({
      modelId: repository.modelId,
      remoteBaseUrl: server.baseUrl,
      maximumProbedArtifacts: 1,
    });

    expect(run.bytesConsumed).toBe(2048);
    expect(run.transportObservations[0]).toMatchObject({
      method: 'GET-range',
      status: 206,
      rangeHonored: true,
      bytesConsumed: 2048,
      abortedByByteBudget: false,
    });
    expect(run.transportObservations[0]?.error).toBeDefined();
  });

  it('records a bounded timeout when the Range response does not arrive in time', async () => {
    const repository = readRepositoryFixture({ name: 'smollm2-135m-instruct' });
    const server = await createHuggingFaceFixtureServer({
      repository,
      behavior: {
        head: 'insufficient',
        range: 'slow',
        slowDelayMs: 100,
      },
    });
    openServers.push(server);

    const run = await runBrowserDownloadVerification({
      modelId: repository.modelId,
      remoteBaseUrl: server.baseUrl,
      maximumProbedArtifacts: 1,
      requestTimeoutMs: 20,
    });

    expect(run.bytesConsumed).toBe(0);
    expect(run.transportObservations[0]).toMatchObject({
      method: 'GET-range',
      status: undefined,
      bytesConsumed: 0,
      abortedByByteBudget: false,
      error: {
        name: 'Error',
        message: 'Browser transport probe request timed out',
      },
    });
  });
});
