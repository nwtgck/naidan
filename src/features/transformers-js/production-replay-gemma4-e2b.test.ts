// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Tool } from '@/01-models/tool';
import type { ChatMessage } from '@/01-models/types';
import { toToolCallId } from '@/01-models/ids';
import imageJson from './production-replay-gemma4-e2b.image.evidence.json';
import { createProductionReplayTestImagePlatform } from './production-replay-test-image-platform';
import inputJson from './production-replay-gemma4-e2b.input.evidence.json';
import toolInputJson from './production-replay-gemma4-e2b.tool-input.evidence.json';
import generationJson from './production-replay-gemma4-e2b.evidence.json';
import continuityJson from './production-replay-gemma4-e2b.continuity.evidence.json';
import budgetContinuityJson from './production-replay-gemma4-e2b.continuity-budget.evidence.json';
import { parseProductionReplayTextEvidence, replayRecordedText } from './production-replay-test-causal-gate';
import { createProductionReplayTestRuntime, type ProductionReplayGenerate } from './production-replay-test-runtime';
import { createSyntheticModelBody } from './download-verification/fixtures/raw-download-replay/synthetic-session-oracle';

const inputEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('reference-template-behavior-matrix'),
  modelId: z.literal('onnx-community/gemma-4-E2B-it-ONNX'),
  revision: z.literal('9f4bef82ea6e296bc69f8a2f5939f73af81b07a6'),
  cases: z.array(z.object({
    caseId: z.enum(['user-generation', 'system-user-generation', 'multi-turn-generation', 'tools-generation']),
    messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()),
    tools: z.array(z.object({ type: z.literal('function'), function: z.object({
      name: z.string(), description: z.string(), parameters: z.record(z.string(), z.json()),
    }).strict() }).strict()),
    addGenerationPrompt: z.literal(true), renderedText: z.string(),
    inputTokenIds: z.array(z.number().int().nonnegative()).min(1),
  }).strict()).length(4),
}).strict().parse(inputJson);

const toolInputEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('reference-template-behavior-matrix'),
  sourceMemberSha256: z.literal('8f15582679e84b7492b24a50da14671d171ec463a6f0eb7cf909aced0807e3ab'),
  modelId: z.literal('onnx-community/gemma-4-E2B-it-ONNX'),
  revision: z.literal('9f4bef82ea6e296bc69f8a2f5939f73af81b07a6'),
  selectedTemplateSha256: z.literal('781d10940fbc44be40064b5d43a056fc486c84ceaa55538226368b57314132bf'),
  caseId: z.literal('tool-result-continuation'),
  messages: z.tuple([
    z.object({ role: z.literal('user'), content: z.string() }).strict(),
    z.object({
      role: z.literal('assistant'), content: z.literal(''),
      tool_calls: z.tuple([z.object({
        id: z.literal('call_template_probe_1'), type: z.literal('function'),
        function: z.object({ name: z.literal('lookup_weather'), arguments: z.literal('{"city":"Tokyo"}') }).strict(),
      }).strict()]),
    }).strict(),
    z.object({ role: z.literal('tool'), tool_call_id: z.literal('call_template_probe_1'), content: z.string() }).strict(),
  ]),
  tools: z.tuple([z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.literal('lookup_weather'), description: z.literal('Return deterministic weather fixture data.'),
      parameters: z.object({
        type: z.literal('object'), properties: z.object({ city: z.object({ type: z.literal('string') }).strict() }).strict(),
        required: z.tuple([z.literal('city')]),
      }).strict(),
    }).strict(),
  }).strict()]),
  addGenerationPrompt: z.literal(true), renderedText: z.string(),
  inputTokenIds: z.array(z.number().int().nonnegative().safe()).min(1),
}).strict().parse(toolInputJson);

const INPUT_BOUNDARY = 'Gemma captured actual native inference input; no generation replay';

function createGemmaSyntheticProtocolRuntime({ generate }: { generate: ProductionReplayGenerate }) {
  return createProductionReplayTestRuntime({
    imagePlatform: undefined, modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision,
    artifacts: [
      'onnx/audio_encoder_q4f16.onnx', 'onnx/audio_encoder_q4f16.onnx_data',
      'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
      'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
    ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
    generate,
  });
}

function emitSyntheticGemmaProtocol({ context, text }: { context: Parameters<ProductionReplayGenerate>[0]; text: string }) {
  const { options, runtime, tokenizer } = context;
  if (!(options.input_ids instanceof runtime.Tensor) || !(options.streamer instanceof runtime.TextStreamer)) throw new Error('Expected actual native Gemma tensors and TextStreamer');
  const ids = tokenizer.encode(text, { add_special_tokens: false });
  expect(tokenizer.decode(ids, { skip_special_tokens: false })).toBe(text);
  const input = Array.from(options.input_ids.data, BigInt);
  // Deliberate synthetic protocol injection, never a recorded model output.
  // Single-token puts exercise the real tokenizer, decoder and parser splits.
  options.streamer.put([input]);
  for (const id of ids) options.streamer.put([[BigInt(id)]]);
  options.streamer.end();
  return { sequences: new runtime.Tensor('int64', BigInt64Array.from([...input, ...ids.map(BigInt)]), [1, input.length + ids.length]), past_key_values: null };
}
const generationEvidence = parseProductionReplayTextEvidence({ value: generationJson });
const continuity = parseProductionReplayTextEvidence({ value: continuityJson });
const budgetContinuitySource = z.object({
  sourceMemberSha256: z.literal('b286f4c6bd00ef73e47cffe36ab34166053003af45cf3fac9a7d9d5c8c52faa6'),
  originalStreamChunks: z.array(z.string()), capture: z.unknown(),
}).strict().parse(budgetContinuityJson);
const budgetContinuity = parseProductionReplayTextEvidence({ value: budgetContinuitySource.capture });

async function createGemmaInputReplay() {
  const inputs: number[][] = [];
  const harness = await createProductionReplayTestRuntime({
    imagePlatform: undefined,
    modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision,
    // Native sessions use identifiable tiny bodies. The actual AutoModel,
    // AutoProcessor, tokenizer and offline resource path are not replaced.
    artifacts: [
      'onnx/audio_encoder_q4f16.onnx', 'onnx/audio_encoder_q4f16.onnx_data',
      'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
      'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
    ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
    generate: async ({ options, runtime }) => {
      if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) {
        throw new Error('Expected actual Gemma input and mask Tensors');
      }
      expect(options.input_ids.type).toBe('int64');
      expect(options.input_ids.location).toBe('cpu');
      expect(options.input_ids.dims).toEqual([1, options.input_ids.data.length]);
      expect(options.attention_mask.type).toBe('int64');
      expect(options.attention_mask.location).toBe('cpu');
      expect(options.attention_mask.dims).toEqual(options.input_ids.dims);
      expect(Array.from(options.attention_mask.data, BigInt)).toEqual(Array.from(options.input_ids.data, () => 1n));
      inputs.push(Array.from(options.input_ids.data, Number));
      // End at the native inference boundary: never supply tokens captured for
      // another input and never invent a successful model/tool response.
      throw new Error(INPUT_BOUNDARY);
    },
  });
  return { harness, inputs };
}

const imageEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('fixed-synthetic-fixture-and-existing-production-strategy'),
  sourceMemberSha256: z.literal('0e88f07503dd9d86c9f5be3c410ac8c431f9f1f971535857cf037b75ce4da1ff'),
  modelId: z.literal('onnx-community/gemma-4-E2B-it-ONNX'),
  revision: z.literal('9f4bef82ea6e296bc69f8a2f5939f73af81b07a6'),
  image: z.object({
    sha256: z.literal('431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460'),
    mimeType: z.literal('image/png'), byteLength: z.literal(68), width: z.literal(1), height: z.literal(1),
  }).strict(),
  messages: z.tuple([z.object({ role: z.literal('user'), content: z.tuple([
    z.object({ type: z.literal('text'), text: z.literal('Describe the single synthetic image in one short phrase.') }).strict(),
    z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string().startsWith('data:image/png;base64,') }).strict() }).strict(),
  ]) }).strict()]),
  inputKeys: z.array(z.string()).length(5),
  inputTensors: z.array(z.object({
    name: z.enum(['input_ids', 'attention_mask', 'pixel_values', 'image_position_ids']),
    dtype: z.enum(['int64', 'float32']), dims: z.array(z.number().int().positive()), location: z.literal('cpu'),
  }).strict()).length(4),
  inputTokenIds: z.array(z.number().int().nonnegative()).length(279),
  generationSettings: z.object({
    maxNewTokens: z.literal(1), temperature: z.literal(0), topP: z.literal(1), doSample: z.literal(false),
  }).strict(),
  unrecorded: z.tuple([
    z.literal('pixel_values-data'), z.literal('image_position_ids-data'),
    z.literal('num_soft_tokens_per_image-value'), z.literal('native-stop-cause'),
  ]),
}).strict().parse(imageJson);

const IMAGE_INPUT_BOUNDARY = 'Gemma real image processor input verified; no native generation replay';

// Both cases exercise the same image-input contract. Only the explicit image
// bytes and independently expected pixels change; no inference tokens are used.
async function verifyGemmaImageInput({ imageUrl, expectedRgba, expectedPixels }: {
  imageUrl: string, expectedRgba: Uint8ClampedArray, expectedPixels: Float32Array,
}) {
  const platform = createProductionReplayTestImagePlatform();
  let verifiedInputs = 0;
  const harness = await createProductionReplayTestRuntime({
    modelId: imageEvidence.modelId, expectedRevision: imageEvidence.revision,
    imagePlatform: { platform, allowedDataUrls: [imageUrl] },
    artifacts: [
      'onnx/audio_encoder_q4f16.onnx', 'onnx/audio_encoder_q4f16.onnx_data',
      'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
      'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
    ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: imageEvidence.modelId, revision: imageEvidence.revision, path }) })),
    generate: async ({ options, runtime }) => {
      const tensors = z.object({
        input_ids: z.instanceof(runtime.Tensor), attention_mask: z.instanceof(runtime.Tensor),
        pixel_values: z.instanceof(runtime.Tensor), image_position_ids: z.instanceof(runtime.Tensor),
        num_soft_tokens_per_image: z.tuple([z.literal(256)]),
      }).parse(options);
      expect(Object.keys(options).sort()).toEqual([
        ...imageEvidence.inputKeys, 'do_sample', 'max_new_tokens', 'past_key_values',
        'return_dict_in_generate', 'stopping_criteria', 'streamer', 'temperature', 'top_p',
      ].sort());
      for (const fact of imageEvidence.inputTensors) {
        const tensor = tensors[fact.name];
        expect({ name: fact.name, dtype: tensor.type, dims: tensor.dims, location: tensor.location }).toEqual(fact);
      }
      expect(Array.from(tensors.input_ids.data, Number)).toEqual(imageEvidence.inputTokenIds);
      expect(tensors.attention_mask.data).toEqual(new BigInt64Array(279).fill(1n));
      expect(tensors.pixel_values.data).toEqual(expectedPixels);

      // These values are independently derived from the fixed 1x1 geometry:
      // 768/16 = 48 patches per side, 2304 real patches, 216 padded patches.
      // The original browser capture recorded shapes, not these tensor values.
      const expectedPositions = new BigInt64Array(2520 * 2).fill(-1n);
      for (let patch = 0; patch < 2304; ++patch) {
        expectedPositions[patch * 2] = BigInt(patch % 48);
        expectedPositions[patch * 2 + 1] = BigInt(Math.floor(patch / 48));
      }
      expect(tensors.image_position_ids.data).toEqual(expectedPositions);
      expect({
        maxNewTokens: options.max_new_tokens, temperature: options.temperature,
        topP: options.top_p, doSample: options.do_sample,
      }).toEqual(imageEvidence.generationSettings);
      expect(options.past_key_values).toBeNull();
      expect(options.return_dict_in_generate).toBe(true);
      ++verifiedInputs;
      // A browser pixel digest was not captured. Do not present independently
      // derived values as recorded bytes or release the original token "The"
      // merely because dimensions and text tokens happen to match.
      throw new Error(IMAGE_INPUT_BOUNDARY);
    },
  });
  try {
    const chunks: string[] = [];
    await expect(harness.provider.chat({
      model: imageEvidence.modelId, messages: [{ role: 'user', content: [
        imageEvidence.messages[0].content[0], { type: 'image_url', image_url: { url: imageUrl } },
      ] }], tools: [],
      parameters: {
        temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined,
        frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined },
      },
      onChunk: ({ chunk }) => chunks.push(chunk),
    })).rejects.toThrow(IMAGE_INPUT_BOUNDARY);
    expect(verifiedInputs).toBe(1);
    expect(chunks).toEqual([]);
    expect(harness.observations.processors).toHaveLength(1);
    expect(harness.observations.inferenceCalls).toHaveLength(1);
    expect(platform.observations.decodes).toEqual([{
      bytes: Uint8Array.from(Buffer.from(imageUrl.split(',')[1]!, 'base64')), rgba: expectedRgba,
    }]);
    expect(platform.observations.draws).toEqual([
      { sourceWidth: 1, sourceHeight: 1, targetWidth: 1, targetHeight: 1 },
      { sourceWidth: 1, sourceHeight: 1, targetWidth: 768, targetHeight: 768 },
    ]);
    expect(harness.observations.localImageFetchCalls).toEqual([imageUrl]);
    expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
    expect(harness.observations.forbiddenTransport).toEqual([]);
    expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  } finally {
    await harness.close();
  }
}

describe('Gemma 4 E2B real Production processor input contracts', () => {
  it.each(inputEvidence.cases.filter(scenario => scenario.tools.length === 0))('$caseId reaches the exact recorded input through the public Provider', async scenario => {
    const replay = await createGemmaInputReplay();
    try {
      const chunks: string[] = [];
      await expect(replay.harness.provider.chat({
        model: inputEvidence.modelId, messages: scenario.messages, tools: [],
        parameters: {
          temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined,
          frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined },
        },
        onChunk: ({ chunk }) => {
          chunks.push(chunk);
        },
      })).rejects.toThrow(INPUT_BOUNDARY);
      expect(replay.inputs).toEqual([scenario.inputTokenIds]);
      expect(chunks).toEqual([]);
      expect(replay.harness.observations.processors).toHaveLength(1);
      const processor = replay.harness.observations.processors[0];
      if (!processor) throw new Error('Actual Gemma processor was not loaded');
      expect(processor.apply_chat_template(scenario.messages, { add_generation_prompt: true }))
        .toBe(scenario.renderedText);
      expect(replay.harness.observations.forbiddenTransport).toEqual([]);
      expect(replay.harness.observations.runtimeAssetFetchCalls).toEqual([replay.harness.observations.expectedRuntimeAssetUrl]);
      expect(replay.harness.observations.fs.activity.filter(item => item.operation.startsWith('writer') || item.operation.startsWith('create') || item.operation === 'remove')).toEqual([]);
    } finally {
      await replay.harness.close();
    }
  }, 30_000);
});

describe('Gemma 4 E2B captured Production Provider generation replay', () => {
  it('delivers the recorded first-turn prefix through the actual processor and streamer before Provider settlement', async () => {
    expect(generationEvidence.identity).toEqual({
      modelId: 'hf.co/onnx-community/gemma-4-E2B-it-ONNX',
      resolvedRevision: inputEvidence.revision,
      investigationRunId: 'e5891b08-6053-4092-87e5-47038836e431',
      transformersJsVersion: '4.2.0',
    });
    let releasedTokenCount = 0;
    const harness = await createProductionReplayTestRuntime({
      imagePlatform: undefined,
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision,
      // Metadata and processor are real. Browser transport and native ORT /
      // inference are explicit test boundaries. The old capture's resolved
      // repository revision does not certify its reused model-weight bytes.
      artifacts: [
        'onnx/audio_encoder_q4f16.onnx', 'onnx/audio_encoder_q4f16.onnx_data',
        'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async ({ options, tokenizer, runtime }) => {
        expect(tokenizer.decode(generationEvidence.modelReplay.generatedTokenIds, { skip_special_tokens: false }))
          .toBe(generationEvidence.modelReplay.generatedText);
        const replay = replayRecordedText({ evidence: generationEvidence, options });
        releasedTokenCount += replay.releasedTokenCount;
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
    });
    try {
      const chunks: string[] = [];
      await harness.provider.chat({
        model: generationEvidence.identity.modelId, messages: generationEvidence.scenario.messages, tools: [],
        parameters: {
          ...generationEvidence.scenario.lmParameters,
          presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined },
        },
        onChunk: ({ chunk }) => {
          chunks.push(chunk);
        },
      });
      const settledChunks = [...chunks];
      expect(releasedTokenCount).toBe(16);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.processors).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => item.operation.startsWith('writer') || item.operation.startsWith('create') || item.operation === 'remove')).toEqual([]);
      // Exact original stream chunks; no timer or drain turns an unsettled
      // callback transport into a successful public generation trace.
      expect(settledChunks).toEqual([
        'Please ', 'provide ', 'the ', '**context** ', 'or ', '**purpose** ',
        'of ', 'the ', '"template ', 'probe ', 'user',
      ]);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('preserves the recorded turn delimiter and visible text in supplied-history continuation', async () => {
    expect(continuity.identity).toEqual(generationEvidence.identity);
    expect(continuity.scenario.messages).toEqual([
      { role: 'user', content: 'Template probe user message.' },
      { role: 'assistant', content: generationEvidence.expectedProviderSemantic.visibleContent },
      { role: 'user', content: 'Continue with one short sentence.' },
    ]);
    expect(continuity.scenario.boundary).toEqual({
      kind: 'recorded-ending', lengthRelation: 'below-requested-budget', lastTokenId: 106, stopCause: 'not-recorded',
    });
    let releasedTokenCount = 0;
    const harness = await createProductionReplayTestRuntime({
      imagePlatform: undefined,
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision,
      artifacts: [
        'onnx/audio_encoder_q4f16.onnx', 'onnx/audio_encoder_q4f16.onnx_data',
        'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async ({ options, tokenizer, runtime }) => {
        expect(tokenizer.decode([106], { skip_special_tokens: false })).toBe('<turn|>');
        expect(tokenizer.decode(continuity.modelReplay.generatedTokenIds, { skip_special_tokens: false }))
          .toBe(continuity.modelReplay.generatedText);
        expect(tokenizer.decode(continuity.modelReplay.generatedTokenIds, { skip_special_tokens: true }))
          .toBe(continuity.expectedProviderSemantic.visibleContent);
        const replay = replayRecordedText({ evidence: continuity, options });
        releasedTokenCount += replay.releasedTokenCount;
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
    });
    try {
      const chunks: string[] = [];
      await harness.provider.chat({
        model: continuity.identity.modelId, messages: continuity.scenario.messages, tools: [],
        parameters: {
          ...continuity.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined,
          stop: undefined, reasoning: { effort: undefined },
        },
        onChunk: ({ chunk }) => chunks.push(chunk),
      });
      const settledChunks = [...chunks];
      expect(releasedTokenCount).toBe(12);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.processors).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // Recorded output, not a claim that native stop-cause selection or a
      // previous Provider callback completed successfully in this harness.
      expect(settledChunks).toEqual(['**What ', 'kind ', 'of ', 'template ', 'are ', 'you ', 'looking ', 'for?**']);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('preserves the separate 16-token continuation capture without inferring why native generation stopped', async () => {
    expect(budgetContinuity.identity).toEqual({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      resolvedRevision: '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6',
      investigationRunId: 'a57b431d-7629-4177-809c-64ba8662afde', transformersJsVersion: '4.2.0',
    });
    expect(budgetContinuity.scenario.messages).toEqual([
      { role: 'user', content: 'Template probe user message.' },
      { role: 'assistant', content: 'Please provide the **context** or **purpose** of the "template probe user' },
      { role: 'user', content: 'Continue with one short sentence.' },
    ]);
    expect(budgetContinuity.scenario.boundary).toEqual({
      kind: 'natural-prefix', lengthRelation: 'equals-requested-budget', stopCause: 'not-recorded',
    });
    expect(budgetContinuity.modelReplay.generatedTokenIds).toEqual([
      1018, 3689, 2712, 529, 7930, 659, 611, 3182, 573, 236881, 1018, 106, 106, 106, 106, 1,
    ]);
    // The earlier capture has the same input and visible text, but stops after
    // 12 recorded tokens. Keep both original variants rather than replacing the
    // earlier source or treating <eos> at the budget limit as a known stop cause.
    expect(budgetContinuity.inputContract.inputTokenIds).toEqual(continuity.inputContract.inputTokenIds);
    expect(budgetContinuity.modelReplay.generatedTokenIds).not.toEqual(continuity.modelReplay.generatedTokenIds);
    let releasedTokenCount = 0;
    const harness = await createProductionReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, imagePlatform: undefined,
      artifacts: [
        'onnx/audio_encoder_q4f16.onnx', 'onnx/audio_encoder_q4f16.onnx_data',
        'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async ({ options, tokenizer, runtime }) => {
        expect(tokenizer.decode([106, 106, 106, 106, 1], { skip_special_tokens: false })).toBe('<turn|><turn|><turn|><turn|><eos>');
        expect(tokenizer.decode(budgetContinuity.modelReplay.generatedTokenIds, { skip_special_tokens: false })).toBe(budgetContinuity.modelReplay.generatedText);
        expect(tokenizer.decode(budgetContinuity.modelReplay.generatedTokenIds, { skip_special_tokens: true })).toBe(budgetContinuity.expectedProviderSemantic.visibleContent);
        expect(options.past_key_values).toBeNull();
        const replay = replayRecordedText({ evidence: budgetContinuity, options });
        releasedTokenCount += replay.releasedTokenCount;
        // Gemma's stateless strategy discards returned KV. The original native
        // cache bytes are not recorded and are not fabricated in this replay.
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
    });
    try {
      const chunks: string[] = [];
      await harness.provider.chat({
        model: budgetContinuity.identity.modelId, messages: budgetContinuity.scenario.messages, tools: [],
        parameters: { ...budgetContinuity.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => chunks.push(chunk),
      });
      const settledChunks = [...chunks];
      expect(releasedTokenCount).toBe(16);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.processors).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      expect(budgetContinuitySource.originalStreamChunks).toEqual(['**What ', 'kind ', 'of ', 'template ', 'are ', 'you ', 'looking ', 'for?**']);
      expect(settledChunks).toEqual(budgetContinuitySource.originalStreamChunks);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('uses only the settled first callback text for a second request in the same loaded runtime', async () => {
    expect(continuity.identity).toEqual(generationEvidence.identity);
    expect(continuity.identity.investigationRunId).toBe('e5891b08-6053-4092-87e5-47038836e431');
    expect(continuity.identity).not.toEqual(budgetContinuity.identity);
    expect(continuity.scenario.boundary).toEqual({
      kind: 'recorded-ending', lengthRelation: 'below-requested-budget', lastTokenId: 106, stopCause: 'not-recorded',
    });
    expect(continuity.modelReplay.generatedTokenIds).toHaveLength(12);
    expect(continuity.scenario.messages).toEqual([
      ...generationEvidence.scenario.messages,
      { role: 'assistant', content: generationEvidence.expectedProviderSemantic.visibleContent },
      { role: 'user', content: 'Continue with one short sentence.' },
    ]);
    const contexts: Parameters<ProductionReplayGenerate>[0][] = [];
    const released: number[] = [];
    const invocations: ProductionReplayGenerate[] = [
      async context => {
        const { options, tokenizer, runtime } = context;
        contexts.push(context);
        expect(tokenizer.decode(generationEvidence.modelReplay.generatedTokenIds, { skip_special_tokens: false })).toBe(generationEvidence.modelReplay.generatedText);
        const replay = replayRecordedText({ evidence: generationEvidence, options });
        released.push(replay.releasedTokenCount);
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
      async context => {
        const { options, tokenizer, runtime } = context;
        contexts.push(context);
        expect(tokenizer.decode(continuity.modelReplay.generatedTokenIds, { skip_special_tokens: false })).toBe(continuity.modelReplay.generatedText);
        expect(tokenizer.decode(continuity.modelReplay.generatedTokenIds, { skip_special_tokens: true })).toBe(continuity.expectedProviderSemantic.visibleContent);
        expect(tokenizer).toBe(harness.observations.processors[0]?.tokenizer);
        // A missing first callback changes the real second input. The gate must
        // reject it BEFORE releasing any captured follow-up tokens. Never fill
        // the assistant message from the fixture to make this invocation pass.
        const replay = replayRecordedText({ evidence: continuity, options });
        released.push(replay.releasedTokenCount);
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
    ];
    const harness = await createProductionReplayTestRuntime({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX', expectedRevision: generationEvidence.identity.resolvedRevision, imagePlatform: undefined,
      artifacts: [
        'onnx/audio_encoder_q4f16.onnx', 'onnx/audio_encoder_q4f16.onnx_data',
        'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async context => {
        const next = invocations.shift();
        if (!next) throw new Error('Unexpected extra inference in two-turn replay');
        return next(context);
      },
    });
    try {
      const firstChunks: string[] = [];
      await harness.provider.chat({
        model: generationEvidence.identity.modelId, messages: generationEvidence.scenario.messages, tools: [],
        parameters: { ...generationEvidence.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => firstChunks.push(chunk),
      });
      // Immutable at settlement: late first callbacks cannot rewrite the next
      // request. There is no timer, callback drain, or artificial callback ACK.
      const firstTextAtSettlement = firstChunks.join('');
      const secondMessages: ChatMessage[] = [
        ...generationEvidence.scenario.messages,
        { role: 'assistant', content: firstTextAtSettlement },
        { role: 'user', content: 'Continue with one short sentence.' },
      ];
      const ortCountAfterFirst = harness.observations.ortCalls.length;
      expect(harness.observations.processors).toHaveLength(1);
      const processorAfterFirst = harness.observations.processors[0];
      const secondChunks: string[] = [];
      let secondOutcome: { status: 'fulfilled' } | { status: 'rejected', error: unknown };
      try {
        await harness.provider.chat({
          model: generationEvidence.identity.modelId, messages: secondMessages, tools: [],
          parameters: { ...continuity.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
          onChunk: ({ chunk }) => secondChunks.push(chunk),
        });
        secondOutcome = { status: 'fulfilled' };
      } catch (error) {
        secondOutcome = { status: 'rejected', error };
      }
      // Direct await, as for turn one; wrapping the promise in another .then
      // would give late callbacks an extra reaction before this snapshot.
      const secondTextAtSettlement = secondChunks.join('');
      expect(contexts).toHaveLength(2);
      expect(contexts[1]!.model).toBe(contexts[0]!.model);
      expect(contexts[1]!.tokenizer).toBe(contexts[0]!.tokenizer);
      expect(contexts.map(context => context.options.past_key_values)).toEqual([null, null]);
      expect(harness.observations.inferenceCalls).toHaveLength(2);
      expect(invocations).toEqual([]);
      expect(ortCountAfterFirst).toBe(4);
      expect(harness.observations.ortCalls).toHaveLength(ortCountAfterFirst);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.processors).toHaveLength(1);
      expect(harness.observations.processors[0]).toBe(processorAfterFirst);
      expect(contexts[1]!.tokenizer).toBe(processorAfterFirst?.tokenizer);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // Report the real rejection as well as both immutable callback snapshots.
      // This is a downstream consequence of the synchronous-native/Comlink
      // settlement counterexample, not a second independent generation defect.
      expect({ firstTextAtSettlement, secondOutcome, secondTextAtSettlement, released }).toEqual({
        firstTextAtSettlement: generationEvidence.expectedProviderSemantic.visibleContent,
        secondOutcome: { status: 'fulfilled' },
        secondTextAtSettlement: continuity.expectedProviderSemantic.visibleContent,
        released: [16, 12],
      });
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('keeps an independent next input free of prior text in the same null-KV loaded runtime', async () => {
    const nextMessages: ChatMessage[] = [{ role: 'user', content: 'A separate synthetic Gemma conversation.' }];
    const nextPrompt = `\
<bos><|turn>user
A separate synthetic Gemma conversation.<turn|>
<|turn>model
`;
    const stop = 'Independent Gemma next input verified; no second output supplied';
    const contexts: Parameters<ProductionReplayGenerate>[0][] = [];
    let firstReleased = 0;
    const invocations: ProductionReplayGenerate[] = [
      async context => {
        contexts.push(context);
        const { options, tokenizer, runtime } = context;
        expect(tokenizer.decode(generationEvidence.modelReplay.generatedTokenIds, { skip_special_tokens: false })).toBe(generationEvidence.modelReplay.generatedText);
        const replay = replayRecordedText({ evidence: generationEvidence, options });
        firstReleased = replay.releasedTokenCount;
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
      async context => {
        contexts.push(context);
        const { options, tokenizer, runtime } = context;
        expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe('781d10940fbc44be40064b5d43a056fc486c84ceaa55538226368b57314132bf');
        const processor = harness.observations.processors[0];
        if (!processor) throw new Error('Expected actual loaded Gemma processor');
        expect(tokenizer).toBe(processor.tokenizer);
        expect(processor.apply_chat_template(nextMessages, { add_generation_prompt: true })).toBe(nextPrompt);
        const ids = tokenizer.encode(nextPrompt, { add_special_tokens: false });
        if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) throw new Error('Expected actual next-input tensors');
        expect(options.input_ids.type).toBe('int64');
        expect(options.input_ids.location).toBe('cpu');
        expect(options.input_ids.dims).toEqual([1, ids.length]);
        expect(Array.from(options.input_ids.data, Number)).toEqual(ids);
        expect(options.attention_mask.type).toBe('int64');
        expect(options.attention_mask.location).toBe('cpu');
        expect(options.attention_mask.dims).toEqual([1, ids.length]);
        expect(Array.from(options.attention_mask.data, BigInt)).toEqual(ids.map(() => 1n));
        expect(Object.keys(options).sort()).toEqual([
          'attention_mask', 'do_sample', 'input_ids', 'max_new_tokens', 'past_key_values',
          'return_dict_in_generate', 'stopping_criteria', 'streamer', 'temperature', 'top_p',
        ].sort());
        expect({ maxNewTokens: options.max_new_tokens, temperature: options.temperature, topP: options.top_p, doSample: options.do_sample })
          .toEqual({ maxNewTokens: 1, temperature: 0, topP: 1, doSample: false });
        expect(options.return_dict_in_generate).toBe(true);
        expect(options.streamer).toBeInstanceOf(runtime.TextStreamer);
        expect(typeof options.stopping_criteria).toBe('function');
        expect(options.past_key_values).toBeNull();
        // No captured response exists for this changed input. This tests input
        // isolation with null KV, not native KV invalidation or generation.
        throw new Error(stop);
      },
    ];
    const harness = await createProductionReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, imagePlatform: undefined,
      artifacts: [
        'onnx/audio_encoder_q4f16.onnx', 'onnx/audio_encoder_q4f16.onnx_data',
        'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async context => {
        const next = invocations.shift();
        if (!next) throw new Error('Unexpected extra inference in independent-input replay');
        return next(context);
      },
    });
    try {
      const firstChunks: string[] = [];
      await harness.provider.chat({
        model: generationEvidence.identity.modelId, messages: generationEvidence.scenario.messages, tools: [],
        parameters: { ...generationEvidence.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => firstChunks.push(chunk),
      });
      const ortCountAfterFirst = harness.observations.ortCalls.length;
      expect(harness.observations.processors).toHaveLength(1);
      const processorAfterFirst = harness.observations.processors[0];
      const secondChunks: string[] = [];
      await expect(harness.provider.chat({
        model: generationEvidence.identity.modelId, messages: nextMessages, tools: [],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => secondChunks.push(chunk),
      })).rejects.toThrow(stop);
      expect(firstReleased).toBe(16);
      expect(secondChunks).toEqual([]);
      expect(contexts).toHaveLength(2);
      expect(contexts[1]!.model).toBe(contexts[0]!.model);
      expect(contexts[1]!.tokenizer).toBe(contexts[0]!.tokenizer);
      expect(contexts.map(context => context.options.past_key_values)).toEqual([null, null]);
      expect(invocations).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(2);
      expect(ortCountAfterFirst).toBe(4);
      expect(harness.observations.ortCalls).toHaveLength(ortCountAfterFirst);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.processors).toHaveLength(1);
      expect(harness.observations.processors[0]).toBe(processorAfterFirst);
      expect(contexts[1]!.tokenizer).toBe(processorAfterFirst?.tokenizer);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
});

describe('Gemma 4 E2B real Production processor input contracts', () => {
  it.each([
    { effort: 'none' as const, enableThinking: false, expectedPrompt: `\
<bos><|turn>user
Template probe user message.<turn|>
<|turn>model
` },
    { effort: 'high' as const, enableThinking: true, expectedPrompt: `\
<bos><|turn>system
<|think|>
<turn|>
<|turn>user
Template probe user message.<turn|>
<|turn>model
` },
  ])('passes explicit $effort to the exact native Gemma thinking input without claiming generated reasoning quality', async ({ effort, enableThinking, expectedPrompt }) => {
    const replay = await createGemmaInputReplay();
    const messages = [{ role: 'user', content: 'Template probe user message.' }];
    try {
      await replay.harness.service.loadDownloadedModel({ modelId: inputEvidence.modelId });
      const processor = replay.harness.observations.processors[0]!;
      const tokenizer = processor.tokenizer;
      if (tokenizer === undefined) throw new Error('Expected actual selected tokenizer');
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe(toolInputEvidence.selectedTemplateSha256);
      const nativeOptions = { add_generation_prompt: true, enable_thinking: enableThinking };
      expect(processor.apply_chat_template(messages, nativeOptions)).toBe(expectedPrompt);
      const expectedIds = tokenizer.encode(expectedPrompt, { add_special_tokens: false });
      await expect(replay.harness.provider.chat({ model: inputEvidence.modelId, messages, tools: [],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort } },
        onChunk: () => {
          throw new Error('Input-only reasoning control must not release output');
        },
      })).rejects.toThrow(INPUT_BOUNDARY);
      expect(replay.inputs).toEqual([expectedIds]);
      expect(replay.harness.observations.inferenceCalls).toHaveLength(1);
      expect(replay.harness.observations.forbiddenTransport).toEqual([]);
      expect(replay.harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await replay.harness.close();
    }
  }, 30_000);
});

describe('Gemma 4 E2B real Production processor input contracts', () => {
  it('preserves a public tool definition in the native Gemma input instead of silently dropping it', async () => {
    const scenario = inputEvidence.cases.find(candidate => candidate.tools.length === 1);
    if (!scenario) throw new Error('Missing selected original Gemma tools-generation observation');
    const execute = vi.fn<Tool['execute']>(async () => {
      throw new Error('Tool execution is outside this input-only test');
    });
    const tool: Tool = {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }), execute,
    };
    const replay = await createGemmaInputReplay();
    try {
      await expect(replay.harness.provider.chat({
        model: inputEvidence.modelId, messages: scenario.messages, tools: [tool],
        parameters: {
          temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined,
          frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined },
        },
        onChunk: () => {
          throw new Error('Input-only test must not emit generated content');
        },
      })).rejects.toThrow(INPUT_BOUNDARY);
      expect(execute).not.toHaveBeenCalled();
      expect(replay.harness.observations.processors).toHaveLength(1);
      const processor = replay.harness.observations.processors[0];
      if (!processor) throw new Error('Actual Gemma processor was not loaded');
      // The old native capture has an open JSON schema. Public Naidan Tools
      // use additionalProperties:false. Verify this exact public shape against
      // the captured rendering rather than assuming the two are equivalent.
      const publicToolDefinition = [{ type: 'function', function: {
        name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
      } }];
      const nativePrompt = z.string().parse(processor.apply_chat_template(scenario.messages, {
        add_generation_prompt: true, tools: publicToolDefinition,
      }));
      expect(nativePrompt).toBe(scenario.renderedText);
      const nativeInputs: unknown = await processor(nativePrompt, null, null, { add_special_tokens: false });
      const nativeIds = z.object({ input_ids: z.instanceof(replay.harness.runtime.Tensor) }).parse(nativeInputs).input_ids;
      expect(Array.from(nativeIds.data, Number)).toEqual(scenario.inputTokenIds);
      expect(replay.harness.observations.forbiddenTransport).toEqual([]);
      expect(replay.harness.observations.runtimeAssetFetchCalls).toEqual([replay.harness.observations.expectedRuntimeAssetUrl]);
      expect(replay.harness.observations.fs.activity.filter(item => item.operation.startsWith('writer') || item.operation.startsWith('create') || item.operation === 'remove')).toEqual([]);
      // This RED is an input contract, independent of callback settlement and
      // natural tool choice. No captured output is released to cross the gap.
      expect(replay.inputs).toEqual([scenario.inputTokenIds]);
    } finally {
      await replay.harness.close();
    }
  }, 30_000);

  it('retains structured tool-call and result association instead of flattening them into ordinary conversation text', async () => {
    const scenario = toolInputEvidence;
    expect(scenario.modelId).toBe(inputEvidence.modelId);
    expect(scenario.revision).toBe(inputEvidence.revision);
    const execute = vi.fn<Tool['execute']>(async () => {
      throw new Error('This supplied-history matrix did not capture a natural tool loop');
    });
    const publicTool: Tool = {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }), execute,
    };
    const publicMessages: ChatMessage[] = [
      scenario.messages[0],
      { role: 'assistant', content: '', tool_calls: [{
        id: toToolCallId({ raw: 'call_template_probe_1' }), type: 'function',
        function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' },
      }] },
      { role: 'tool', content: scenario.messages[2].content, tool_call_id: toToolCallId({ raw: 'call_template_probe_1' }) },
    ];
    const replay = await createGemmaInputReplay();
    try {
      expect(publicMessages).toStrictEqual(scenario.messages);
      await replay.harness.service.loadDownloadedModel({ modelId: scenario.modelId });
      expect(replay.harness.observations.processors).toHaveLength(1);
      const processor = replay.harness.observations.processors[0];
      if (!processor) throw new Error('Actual Gemma processor was not loaded');
      const tokenizer = processor.tokenizer;
      if (!tokenizer) throw new Error('Actual Gemma tokenizer was not loaded');
      expect(createHash('sha256').update(tokenizer.get_chat_template({ tools: scenario.tools })).digest('hex'))
        .toBe(scenario.selectedTemplateSha256);
      const strictTools = scenario.tools.map(tool => ({
        ...tool, function: { ...tool.function, parameters: { ...tool.function.parameters, additionalProperties: false } },
      }));
      expect(processor.apply_chat_template(scenario.messages, { add_generation_prompt: true, tools: scenario.tools }))
        .toBe(scenario.renderedText);
      expect(processor.apply_chat_template(scenario.messages, { add_generation_prompt: true, tools: strictTools }))
        .toBe(scenario.renderedText);
      const originalInputs: unknown = await processor(scenario.renderedText, null, null, { add_special_tokens: false });
      const originalIds = z.object({ input_ids: z.instanceof(replay.harness.runtime.Tensor) }).parse(originalInputs).input_ids;
      expect(Array.from(originalIds.data, Number)).toEqual(scenario.inputTokenIds);

      // Original JSON-string arguments are pasted inside another pair of braces.
      // Preserve that capture above, but use an independently specified native
      // mapping below for the structured-input contract. It is a CURRENT oracle,
      // not a claim of captured successful mapped input or natural generation.
      const nativeMappedMessages = [
        scenario.messages[0],
        { role: 'assistant', content: '', tool_calls: [{
          id: 'call_template_probe_1', type: 'function',
          function: { name: 'lookup_weather', arguments: { city: 'Tokyo' } },
        }] },
        scenario.messages[2],
      ];
      const originalCallBody = 'call:lookup_weather{{"city":"Tokyo"}}';
      expect(scenario.renderedText.split(originalCallBody)).toHaveLength(2);
      const mappedPrompt = scenario.renderedText.replace(originalCallBody, 'call:lookup_weather{city:<|"|>Tokyo<|"|>}');
      expect(processor.apply_chat_template(nativeMappedMessages, { add_generation_prompt: true, tools: strictTools }))
        .toBe(mappedPrompt);
      // Association is observable: changing only the result ID must not silently
      // keep attributing that result to lookup_weather.
      const responseName = 'response:lookup_weather';
      expect(mappedPrompt.split(responseName)).toHaveLength(2);
      const unmatchedMessages = [
        nativeMappedMessages[0]!, nativeMappedMessages[1]!,
        { ...scenario.messages[2], tool_call_id: 'call_unmatched_probe' },
      ];
      // Current native get('name') returns null; default('unknown') does not
      // replace it. An unmatched result is rejected, not attributed to the old
      // call. This records a native diagnostic, not a desired public error text.
      expect(() => processor.apply_chat_template(unmatchedMessages, { add_generation_prompt: true, tools: strictTools }))
        .toThrow('Cannot perform operation on null values');
      expect(mappedPrompt.split(scenario.messages[2].content)).toHaveLength(2);
      expect(processor.apply_chat_template([
        nativeMappedMessages[0]!, nativeMappedMessages[1]!,
        { ...scenario.messages[2], content: 'Changed synthetic result.' },
      ], { add_generation_prompt: true, tools: strictTools }))
        .toBe(mappedPrompt.replace(scenario.messages[2].content, 'Changed synthetic result.'));
      const mappedInputs: unknown = await processor(mappedPrompt, null, null, { add_special_tokens: false });
      const mappedIds = z.object({ input_ids: z.instanceof(replay.harness.runtime.Tensor) }).parse(mappedInputs).input_ids;
      const expectedIds = Array.from(mappedIds.data, Number);

      const onToolCall = vi.fn();
      const onToolResult = vi.fn();
      const chunks: string[] = [];
      await expect(replay.harness.provider.chat({
        model: scenario.modelId, messages: publicMessages, tools: [publicTool],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => chunks.push(chunk), onToolCall, onToolResult,
      })).rejects.toThrow(INPUT_BOUNDARY);
      expect(chunks).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(onToolCall).not.toHaveBeenCalled();
      expect(onToolResult).not.toHaveBeenCalled();
      expect(replay.harness.observations.inferenceCalls).toHaveLength(1);
      expect(replay.harness.observations.localImageFetchCalls).toEqual([]);
      expect(replay.harness.observations.forbiddenTransport).toEqual([]);
      expect(replay.harness.observations.runtimeAssetFetchCalls).toEqual([replay.harness.observations.expectedRuntimeAssetUrl]);
      expect(replay.harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // Native role/ID/call delimiters are material here: replacing them with
      // plain assistant/user summaries is not merely a strict-schema difference.
      // Compare only after control and safety checks; no generated token is used.
      expect(replay.inputs).toEqual([expectedIds]);
    } finally {
      await replay.harness.close();
    }
  }, 30_000);
});

describe('Gemma 4 E2B synthetic native tool protocol through the complete Provider boundary', () => {
  it('executes a native-format synthetic tool call once and supplies its structured result to the next real processor input', async () => {
    const messages = [{ role: 'user', content: 'Use the synthetic weather tool for Tokyo.' }];
    const execute = vi.fn<Tool['execute']>(async ({ args }) => {
      expect(args).toEqual({ city: 'Tokyo' });
      return { status: 'success', content: 'Synthetic weather result: clear.' };
    });
    const tool: Tool = { name: 'lookup_weather', description: 'Return deterministic weather fixture data.', parametersSchema: z.object({ city: z.string() }), execute };
    const definition = { type: 'function', function: { name: tool.name, description: tool.description,
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } } };
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();
    const chunks: string[] = [];
    let turns = 0;
    const harness = await createGemmaSyntheticProtocolRuntime({ generate: async context => {
      const { tokenizer, options, runtime } = context;
      ++turns;
      let nativeMessages: Array<{ role: string; content: string } & Record<string, unknown>>;
      if (turns === 1) {
        nativeMessages = messages;
      } else {
        expect(turns).toBe(2);
        expect(execute).toHaveBeenCalledOnce();
        expect(onToolCall).toHaveBeenCalledOnce();
        const id = z.string().parse(onToolCall.mock.calls[0]![0].id);
        nativeMessages = [...messages, { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: tool.name, arguments: { city: 'Tokyo' } } }] },
          { role: 'tool', tool_call_id: id, content: 'Synthetic weather result: clear.' }];
      }
      const expected = tokenizer.apply_chat_template(nativeMessages, { tokenize: false, add_generation_prompt: true, tools: [definition] });
      if (!(options.input_ids instanceof runtime.Tensor)) throw new Error('Expected actual input IDs');
      expect(Array.from(options.input_ids.data, Number)).toEqual(tokenizer.encode(z.string().parse(expected), { add_special_tokens: false }));
      expect(options.past_key_values).toBeNull();
      return emitSyntheticGemmaProtocol({ context, text: turns === 1
        ? '<|tool_call>call:lookup_weather{city:<|"|>Tokyo<|"|>}<tool_call|><|tool_response>'
        : 'Synthetic final answer.<turn|>' });
    } });
    try {
      await harness.provider.chat({ model: inputEvidence.modelId, messages, tools: [tool],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => chunks.push(chunk), onToolCall, onToolResult });
      expect(turns).toBe(2);
      expect(execute).toHaveBeenCalledOnce();
      expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({ result: { status: 'success', content: 'Synthetic weather result: clear.' } }));
      expect(chunks.join('')).toBe('Synthetic final answer.');
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.inferenceCalls).toHaveLength(2);
      expect(harness.observations.processors).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('rejects an unfinished second native tool call without executing the earlier complete call', async () => {
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: 'Must not execute' }));
    const tool: Tool = { name: 'lookup_weather', description: 'Synthetic weather tool.', parametersSchema: z.object({ city: z.string() }), execute };
    const harness = await createGemmaSyntheticProtocolRuntime({ generate: async context => emitSyntheticGemmaProtocol({ context,
      text: '<|tool_call>call:lookup_weather{city:<|"|>Tokyo<|"|>}<tool_call|><|tool_call>call:lookup_weather{city:' }) });
    try {
      const onToolCall = vi.fn();
      await expect(harness.provider.chat({ model: inputEvidence.modelId, messages: [{ role: 'user', content: 'Use the synthetic tool.' }], tools: [tool],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: vi.fn(), onToolCall })).rejects.toThrow(/Gemma.*tool.*protocol/i);
      expect(execute).not.toHaveBeenCalled();
      expect(onToolCall).not.toHaveBeenCalled();
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it.each([
    { label: 'explicit null accepted by the registered tool schema', payload: 'value:null' },
    { label: 'an unsafe bare argument key accepted by the registered tool schema', payload: 'params:{unsafe:key:1}' },
    { label: 'an unbalanced native quote delimiter', payload: 'value:<|"|>first<|"|>second<|"|>' },
  ])('rejects $label before publishing or executing any call', async ({ payload }) => {
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: 'Must not execute' }));
    const tool: Tool = { name: 'capture_value', description: 'Accept a synthetic value.',
      parametersSchema: z.object({ value: z.null().optional(), params: z.object({}).catchall(z.number()).optional() }), execute };
    expect(tool.parametersSchema.strict().safeParse({ value: null }).success).toBe(true);
    expect(tool.parametersSchema.strict().safeParse({ params: { 'unsafe:key': 1 } }).success).toBe(true);
    expect(tool.parametersSchema.strict().safeParse({}).success).toBe(true);
    const harness = await createGemmaSyntheticProtocolRuntime({ generate: async context => emitSyntheticGemmaProtocol({ context,
      text: `<|tool_call>call:capture_value{}<tool_call|><|tool_call>call:capture_value{${payload}}<tool_call|>` }) });
    try {
      const onToolCall = vi.fn();
      await expect(harness.provider.chat({ model: inputEvidence.modelId, messages: [{ role: 'user', content: 'Use the synthetic tool.' }], tools: [tool],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: vi.fn(), onToolCall })).rejects.toThrow(/Gemma.*(?:tool.*protocol|template)/i);
      expect(execute).not.toHaveBeenCalled();
      expect(onToolCall).not.toHaveBeenCalled();
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('reports an unknown native tool name without executing a registered tool and continues with the actual error result input', async () => {
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: 'Must not execute' }));
    const tool: Tool = { name: 'registered_tool', description: 'Registered synthetic tool.', parametersSchema: z.object({ value: z.number() }), execute };
    let turns = 0;
    const harness = await createGemmaSyntheticProtocolRuntime({ generate: async context => {
      ++turns;
      if (turns === 2) {
        const { options, runtime, tokenizer } = context;
        if (!(options.input_ids instanceof runtime.Tensor)) throw new Error('Expected actual input IDs');
        expect(tokenizer.decode(Array.from(options.input_ids.data, Number), { skip_special_tokens: false })).toContain('Tool "unknown_tool" not found.');
      }
      expect(turns).toBeLessThanOrEqual(2);
      return emitSyntheticGemmaProtocol({ context, text: turns === 1
        ? '<|tool_call>call:unknown_tool{value:1}<tool_call|>' : 'Synthetic unavailable tool answer.<turn|>' });
    } });
    try {
      const onToolResult = vi.fn();
      await harness.provider.chat({ model: inputEvidence.modelId, messages: [{ role: 'user', content: 'Use the synthetic tool.' }], tools: [tool],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: vi.fn(), onToolResult });
      expect(execute).not.toHaveBeenCalled();
      expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({ result: { status: 'error', code: 'other', message: 'Tool "unknown_tool" not found.' } }));
      expect(harness.observations.inferenceCalls).toHaveLength(2);
      expect(harness.observations.forbiddenTransport).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('rejects a lossy tool result after its one actual execution and before the next native inference', async () => {
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: 'Synthetic result<|"|>delimiter' }));
    const tool: Tool = { name: 'capture_value', description: 'Synthetic tool result.', parametersSchema: z.object({ value: z.number() }), execute };
    const harness = await createGemmaSyntheticProtocolRuntime({ generate: async context => emitSyntheticGemmaProtocol({ context,
      text: '<|tool_call>call:capture_value{value:1}<tool_call|>' }) });
    try {
      const onToolResult = vi.fn();
      await expect(harness.provider.chat({ model: inputEvidence.modelId, messages: [{ role: 'user', content: 'Use the synthetic tool.' }], tools: [tool],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: vi.fn(), onToolResult })).rejects.toThrow('quote delimiter');
      expect(execute).toHaveBeenCalledOnce();
      expect(onToolResult).toHaveBeenCalledOnce();
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
});

describe('Gemma 4 E2B actual Production image input', () => {
  it('matches the captured token/shape facts and independently derived black pixels through actual RawImage and processor', async () => {
    const imageUrl = imageEvidence.messages[0].content[1].image_url.url;
    const bytes = Buffer.from(imageUrl.split(',')[1]!, 'base64');
    expect(bytes.length).toBe(imageEvidence.image.byteLength);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(imageEvidence.image.sha256);
    // The legacy fixture name said "transparent", but its actual pixel is opaque black.
    await verifyGemmaImageInput({
      imageUrl, expectedRgba: Uint8ClampedArray.of(0, 0, 0, 255), expectedPixels: new Float32Array(2520 * 768),
    });
  }, 30_000);

  it('changes every real pixel for a synthetic white image while retaining zero padding and the same geometry', async () => {
    // Independently encoded 1x1 grayscale-alpha white PNG, not browser Evidence.
    // All 2304 real patches rescale 255 to 1; 216 padding patches remain zero.
    const expectedPixels = new Float32Array(2520 * 768);
    expectedPixels.fill(1, 0, 2304 * 768);
    await verifyGemmaImageInput({
      imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII=',
      expectedRgba: Uint8ClampedArray.of(255, 255, 255, 255), expectedPixels,
    });
  }, 30_000);
});
