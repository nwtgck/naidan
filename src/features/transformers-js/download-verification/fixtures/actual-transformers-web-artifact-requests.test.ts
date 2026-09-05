import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isHuggingFaceModelArtifactUrl } from '@/features/transformers-js/runtime/configure-hosted-runtime';
import {
  createModelArtifactRequestBarrier,
  huggingFaceResolveArtifactRequest,
} from '@/features/transformers-js/download-verification/model-artifact-request-worker/request-barrier';

interface ActualTransformersWebEnv {
  allowLocalModels: boolean;
  allowRemoteModels: boolean;
  useBrowserCache: boolean;
  useCustomCache: boolean;
  fetch: typeof fetch;
}

interface ActualTransformersWebModule {
  AutoModelForCausalLM: {
    from_pretrained: (
      modelId: string,
      options: {
        config: Record<string, unknown>;
        revision: string;
        device: 'webgpu';
        dtype: 'q4f16' | 'q4';
        silent: true;
      },
    ) => Promise<unknown>;
  };
  env: ActualTransformersWebEnv;
}

const MODEL_ID = 'LiquidAI/LFM2.5-230M-ONNX';
const REVISION = 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d';
const QUIESCENCE_MS = 100;

let restoreEnvironment: (() => void) | undefined;

afterEach(() => {
  restoreEnvironment?.();
  restoreEnvironment = undefined;
});

async function loadActualTransformersWebModule(): Promise<ActualTransformersWebModule> {
  const moduleUrl = pathToFileURL(resolve(
    process.cwd(),
    'node_modules/@huggingface/transformers/dist/transformers.web.js',
  )).href;
  return await import(/* @vite-ignore */ moduleUrl) as unknown as ActualTransformersWebModule;
}

function readExactConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(
    process.cwd(),
    'src/features/transformers-js/download-verification/fixtures/artifacts/lfm2-5-230m/config.json',
  ), 'utf8')) as Record<string, unknown>;
}

function repositoryRelativePath({ url }: { url: string }): string {
  const parsed = new URL(url);
  const marker = `/resolve/${REVISION}/`;
  const markerIndex = parsed.pathname.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Unexpected Transformers.js request URL: ${parsed.origin}${parsed.pathname}`);
  return decodeURIComponent(parsed.pathname.slice(markerIndex + marker.length));
}

async function observeActualRequests({ dtype }: { dtype: 'q4f16' | 'q4' }): Promise<{
  artifactPaths: string[];
  nonArtifactPaths: string[];
}> {
  const transformers = await loadActualTransformersWebModule();
  const originalGlobalFetch = globalThis.fetch;
  const originalEnv = {
    allowLocalModels: transformers.env.allowLocalModels,
    allowRemoteModels: transformers.env.allowRemoteModels,
    useBrowserCache: transformers.env.useBrowserCache,
    useCustomCache: transformers.env.useCustomCache,
    fetch: transformers.env.fetch,
  };
  const nonArtifactPaths: string[] = [];
  const barrier = createModelArtifactRequestBarrier({ quiescenceMs: QUIESCENCE_MS });

  const interceptedFetch: typeof fetch = async input => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const path = repositoryRelativePath({ url });
    if (isHuggingFaceModelArtifactUrl({ url })) {
      const request = huggingFaceResolveArtifactRequest({ url });
      if (request === undefined) throw new Error(`Could not parse actual Transformers.js artifact URL: ${url}`);
      return await barrier.observe({ request });
    }

    nonArtifactPaths.push(path);
    return new Response(null, { status: 404 });
  };

  globalThis.fetch = interceptedFetch;
  transformers.env.fetch = interceptedFetch;
  transformers.env.allowLocalModels = false;
  transformers.env.allowRemoteModels = true;
  transformers.env.useBrowserCache = false;
  transformers.env.useCustomCache = false;
  restoreEnvironment = () => {
    globalThis.fetch = originalGlobalFetch;
    transformers.env.fetch = originalEnv.fetch;
    transformers.env.allowLocalModels = originalEnv.allowLocalModels;
    transformers.env.allowRemoteModels = originalEnv.allowRemoteModels;
    transformers.env.useBrowserCache = originalEnv.useBrowserCache;
    transformers.env.useCustomCache = originalEnv.useCustomCache;
  };

  // Deliberately leave the load pending after request quiescence. Rejecting the held model
  // fetches makes the real TJS web bundle leave parallel internal rejections unsettled in Node.
  // A permanently pending test-only fetch transfers zero model bytes and never reaches ORT Session.create.
  void transformers.AutoModelForCausalLM.from_pretrained(MODEL_ID, {
    config: readExactConfig(),
    revision: REVISION,
    device: 'webgpu',
    dtype,
    silent: true,
  });

  try {
    const requests = await barrier.waitForQuiescence();
    return {
      artifactPaths: [...new Set(requests.map(request => request.path))].sort((a, b) => a.localeCompare(b)),
      nonArtifactPaths: [...new Set(nonArtifactPaths)].sort((a, b) => a.localeCompare(b)),
    };
  } finally {
    barrier.dispose();
  }
}

describe('actual Transformers.js web bundle artifact requests for LFM2.5-230M', () => {
  it('requests the nonexistent q4f16 core and external-data paths from the exact public config', async () => {
    const observation = await observeActualRequests({ dtype: 'q4f16' });

    expect(observation.artifactPaths).toEqual([
      'onnx/model_q4f16.onnx',
      'onnx/model_q4f16.onnx_data',
    ]);
    expect(observation.nonArtifactPaths).toEqual(['generation_config.json']);
  });

  it('requests the repository-backed q4 core and external-data paths from the same config', async () => {
    const observation = await observeActualRequests({ dtype: 'q4' });

    expect(observation.artifactPaths).toEqual([
      'onnx/model_q4.onnx',
      'onnx/model_q4.onnx_data',
    ]);
    expect(observation.nonArtifactPaths).toEqual(['generation_config.json']);
  });
});
