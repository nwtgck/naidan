// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createProviderReplayTestRuntime, type ProviderReplayGenerate } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';
import { createProviderReplayTestImagePlatform } from '@/features/transformers-js/replay-models/support/provider-replay-test-image-platform';
import { createSyntheticModelBody } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';
import { downloadRuntimeAcceptanceIdentity } from '@/features/transformers-js/download-verification/evidence/runtime-acceptance-identity';

const modelId = 'onnx-community/Qwen3.5-2B-ONNX';
const revision = 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb';
// Fixed synthetic investigation image; no user attachment or conversation.
const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const textArtifacts = ['onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data', 'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data'];
const visionArtifacts = ['onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data'];

function createRouteRuntime({ paths, generate }: { paths: string[], generate: ProviderReplayGenerate }) {
  return createProviderReplayTestRuntime({
    modelId, expectedRevision: revision, cacheRevision: revision, metadataCache: 'all-fixture',
    imagePlatform: { platform: createProviderReplayTestImagePlatform(), allowedDataUrls: [imageUrl] },
    artifacts: paths.map(path => ({ path, bytes: createSyntheticModelBody({ modelId, revision, path }) })),
    generate,
  });
}

function assertReadOnly({ harness }: { harness: Awaited<ReturnType<typeof createRouteRuntime>> }) {
  expect(harness.observations.forbiddenTransport).toEqual([]);
  expect(harness.observations.fs.activity.filter(item => item.operation.startsWith('writer') || item.operation.startsWith('create') || item.operation === 'remove')).toEqual([]);
}

describe('Qwen image generation session ownership', () => {
  it('does not certify frozen vision acceptance from an actual SHA-addressed text fallback Load receipt', async () => {
    const harness = await createRouteRuntime({ paths: textArtifacts, generate: async () => {
      throw new Error('No generation needed for receipt');
    } });
    const { createTransformersJsGenerationCaptureClient } = await import('@/features/transformers-js/worker/client-hosted');
    const capture = createTransformersJsGenerationCaptureClient({ runId: 'qwen-text-fallback', workerEpoch: 1, getActiveRequest: () => undefined,
      limits: { maxCalls: 8, maxInvocationsPerCall: 4, maxEvents: 256, maxTextBytes: 8192, maxTensorBytes: 8192, maxTotalTensorBytes: 65536,
        maxTokensPerStreamEvent: 4096, maxTotalStreamTokens: 16384, maxTotalStreamTokenBytes: 262144 } });
    try {
      await capture.client.loadDownloadedModel({ modelId, revisionSelection: { kind: 'pinned', revision: revision }, progressCallback: () => undefined });
      const result = await capture.takeGenerationCapture();
      if (result.status !== 'not-started' || result.loadObservation?.outcome.status !== 'accepted') throw new Error('Expected actual Load receipt before generation');
      const receipt = result.loadObservation.outcome.receipt;
      expect(receipt).toMatchObject({ autoClass: 'AutoModelForCausalLM', cacheLookup: { revision }, resourceHealth: 'healthy-after-close' });
      expect(receipt.plannedRequiredPaths.filter(path => path.startsWith('onnx/')).sort()).toEqual([...textArtifacts].sort());
      const evidence = {
        run: { normalizedModelId: modelId, resolvedRevision: revision },
        runtimeCompletion: { status: 'accepted' as const, repositoryResolvedRevision: revision, cacheRevision: revision, loaderRevisionOption: revision, selectedCandidate: receipt.candidate, receipt },
        modelArtifactObservations: [{ status: 'observed' as const, modelId, revision, autoClass: 'AutoModelForImageTextToText' as const, candidate: receipt.candidate, paths: [...textArtifacts, ...visionArtifacts] }],
      };
      expect(downloadRuntimeAcceptanceIdentity({ evidence })).toBe('unverified');
      // Local acceptance is healthy; it is the different frozen vision contract
      // that remains unverified, not an invented Load failure.
      expect(downloadRuntimeAcceptanceIdentity({ evidence: { ...evidence, modelArtifactObservations: [{ ...evidence.modelArtifactObservations[0]!, autoClass: 'AutoModelForCausalLM', paths: textArtifacts }] } })).toBe('exact-resolved-revision');
      assertReadOnly({ harness });
    } finally {
      await capture.client.dispose(); await harness.close();
    }
  }, 30_000);

  it('reaches the vision session through actual public input and native generation', async () => {
    const visionBoundary = 'Synthetic vision inference reached; no image output supplied';
    const stages: string[] = [];
    let nativeFailure: unknown;
    const harness = await createProviderReplayTestRuntime({
      modelId, expectedRevision: revision, cacheRevision: revision, metadataCache: 'all-fixture',
      imagePlatform: { platform: createProviderReplayTestImagePlatform(), allowedDataUrls: [imageUrl] },
      artifacts: [
        'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId, revision, path }) })),
      generate: async ({ model, options, runtime }) => {
        stages.push('native-generate');
        const sessions = model.sessions;
        const embed = sessions['embed_tokens'];
        if (!embed || !(options.input_ids instanceof runtime.Tensor)) throw new Error('Missing actual text input or embedding session');
        const length = options.input_ids.dims[1]!;
        // Only native ORT inference is supplied. Model dispatch, text embedding,
        // image dispatch and session validation remain the actual runtime.
        Object.assign(embed, {
          inputNames: ['input_ids'],
          run: async () => {
            stages.push('embedding-inference');
            return { inputs_embeds: new runtime.Tensor('float32', new Float32Array(length), [1, length, 1]).ort_tensor };
          },
        });
        const vision = sessions['vision_encoder'];
        if (vision) Object.assign(vision, {
          inputNames: ['pixel_values', 'image_grid_thw'],
          run: async () => {
            stages.push('vision-inference'); throw new Error(visionBoundary);
          },
        });
        const encodeImage = vi.spyOn(model, 'encode_image');
        try {
          // The shared harness replaces generate; invoke its unmodified inherited
          // implementation instead of accepting tensors at the entry boundary.
          return await runtime.PreTrainedModel.prototype.generate.call(model, options);
        } catch (error) {
          nativeFailure = error;
          throw error;
        } finally {
          if (encodeImage.mock.calls.length) stages.push('image-encoder-called');
          encodeImage.mockRestore();
        }
      },
    });
    try {
      await expect(harness.provider.chat({
        model: modelId, messages: [{ role: 'user', content: [
          { type: 'text', text: 'Describe the single synthetic image in one short phrase.' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ] }], tools: [],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: vi.fn(), onToolCall: vi.fn(), onToolEvent: vi.fn(), onToolResult: vi.fn(),
      }), JSON.stringify({ stages, nativeFailure })).rejects.toThrow(visionBoundary);
      expect(stages).toEqual(['native-generate', 'embedding-inference', 'vision-inference', 'image-encoder-called']);
      expect(harness.observations.localImageFetchCalls).toEqual([imageUrl]);
      expect(harness.observations.ortCalls).toHaveLength(3);
      assertReadOnly({ harness });
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('keeps a complete text-only cache usable and refuses images without loading again', async () => {
    const generate = vi.fn<ProviderReplayGenerate>(async ({ options, runtime }) => {
      if (!(options.input_ids instanceof runtime.Tensor) || !(options.streamer instanceof runtime.TextStreamer)) throw new Error('Missing actual text input');
      // Synthetic text settlement validates the public execution path only.
      options.streamer.put(options.input_ids.tolist());
      options.streamer.put([[40n]]);
      options.streamer.end();
      return new runtime.Tensor('int64', BigInt64Array.from([...options.input_ids.data as BigInt64Array, 40n]), [1, options.input_ids.dims[1]! + 1]);
    });
    const harness = await createRouteRuntime({ paths: textArtifacts, generate });
    try {
      const onChunk = vi.fn();
      const request = {
        model: modelId, tools: [],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk, onToolCall: vi.fn(), onToolEvent: vi.fn(), onToolResult: vi.fn(),
      };
      await harness.provider.chat({ ...request, messages: [{ role: 'user', content: 'Hello.' }] });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(onChunk).toHaveBeenCalled();
      expect(harness.observations.ortCalls).toHaveLength(2);
      await expect(harness.provider.chat({ ...request, messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe this image.' }, { type: 'image_url', image_url: { url: imageUrl } },
      ] }] })).rejects.toThrow('text-only local candidate');
      expect(generate).toHaveBeenCalledTimes(1);
      expect(harness.observations.ortCalls).toHaveLength(2);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      assertReadOnly({ harness });
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('rejects an incomplete text and image cache before any native session', async () => {
    const generate = vi.fn<ProviderReplayGenerate>(async () => {
      throw new Error('Generation must not start');
    });
    const harness = await createRouteRuntime({ paths: ['onnx/embed_tokens_q4f16.onnx'], generate });
    try {
      await expect(harness.service.loadDownloadedModel({ modelId })).rejects.toThrow('Downloaded model is incomplete');
      expect(harness.observations.ortCalls).toEqual([]);
      expect(generate).not.toHaveBeenCalled();
      assertReadOnly({ harness });
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('does not downgrade after a planned vision resource disappears during Load', async () => {
    const generate = vi.fn<ProviderReplayGenerate>(async () => {
      throw new Error('Generation must not start');
    });
    const harness = await createRouteRuntime({ paths: [...textArtifacts, ...visionArtifacts], generate });
    const original = harness.runtime.AutoModelForImageTextToText.from_pretrained.bind(harness.runtime.AutoModelForImageTextToText);
    const imageLoad = vi.spyOn(harness.runtime.AutoModelForImageTextToText, 'from_pretrained').mockImplementation(async (...args) => {
      // Exact loader boundary occurs after local planning, before native reads.
      harness.observations.fs.files.delete(`models/huggingface.co/${modelId}/resolve/${revision}/onnx/vision_encoder_q4f16.onnx`);
      return original(...args);
    });
    const textLoad = vi.spyOn(harness.runtime.AutoModelForCausalLM, 'from_pretrained');
    try {
      await expect(harness.service.loadDownloadedModel({ modelId })).rejects.toThrow();
      expect(imageLoad).toHaveBeenCalledTimes(1);
      expect(textLoad).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
      assertReadOnly({ harness });
    } finally {
      imageLoad.mockRestore(); textLoad.mockRestore(); await harness.close();
    }
  }, 30_000);
});
