// @vitest-environment node
import { captureProviderChat, type ProviderChatCapture } from '@/features/transformers-js/replay-models/support/capture-provider-chat';
import { providerReplayCatalog } from './provider-evidence-catalog';
import { assembleProviderSequenceEvidence } from '@/features/transformers-js/replay-models/support/provider-replay-evidence';
import { createProviderRequestReplay } from '@/features/transformers-js/replay-models/support/provider-replay-request';
import { verifyCapturedFullReplay } from '@/features/transformers-js/replay-models/support/provider-replay-test-captured-full';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Tool } from '@/01-models/tool';
import type { ChatMessage } from '@/01-models/types';
import { toToolCallId } from '@/01-models/ids';
import imageJson from './provider-image-input-only.evidence.json';
import { createProviderReplayTestImagePlatform } from '@/features/transformers-js/replay-models/support/provider-replay-test-image-platform';
import inputJson from './provider-template-inputs.evidence.json';
import toolInputJson from './provider-template-tool-inputs.evidence.json';
import generationJson from './provider-prefix-output.evidence.json';
import continuityJson from './provider-supplied-history-prefix.evidence.json';
import budgetContinuityJson from './provider-supplied-history-budget-prefix.evidence.json';
import { parseProviderReplayTextEvidence, replayRecordedText } from '@/features/transformers-js/replay-models/support/provider-replay-test-causal-gate';
import { createProviderReplayTestRuntime, type ProviderReplayGenerate } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';
import { createSyntheticModelBody } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';

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

function createGemmaSyntheticProtocolRuntime({ generate }: { generate: ProviderReplayGenerate }) {
  return createProviderReplayTestRuntime({
    imagePlatform: undefined, modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, cacheRevision: inputEvidence.revision, metadataCache: "all-fixture",
    artifacts: [
      'onnx/audio_encoder_q4f16.onnx', 'onnx/audio_encoder_q4f16.onnx_data',
      'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
      'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
    ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
    generate,
  });
}

function emitSyntheticGemmaProtocol({ context, text }: { context: Parameters<ProviderReplayGenerate>[0]; text: string }) {
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
const generationEvidence = parseProviderReplayTextEvidence({ value: generationJson });
const continuity = parseProviderReplayTextEvidence({ value: continuityJson });
const budgetContinuitySource = z.object({
  sourceMemberSha256: z.literal('b286f4c6bd00ef73e47cffe36ab34166053003af45cf3fac9a7d9d5c8c52faa6'),
  originalStreamChunks: z.array(z.string()), capture: z.unknown(),
}).strict().parse(budgetContinuityJson);
const budgetContinuity = parseProviderReplayTextEvidence({ value: budgetContinuitySource.capture });

// Input-only captures retain typed values independently of native disposal.
function captureGemmaNativeInput({ options, runtime }: Parameters<ProviderReplayGenerate>[0]) {
  const tensor = ({ value }: { value: unknown }) => value instanceof runtime.Tensor
    ? { isTensor: true as const, type: value.type, location: value.location, dims: [...value.dims], data: value.data.slice() }
    : { isTensor: false as const };
  return {
    tensors: {
      input_ids: tensor({ value: options.input_ids }), attention_mask: tensor({ value: options.attention_mask }),
      pixel_values: tensor({ value: options.pixel_values }), image_position_ids: tensor({ value: options.image_position_ids }),
    },
    optionKeys: Object.keys(options), softTokens: structuredClone(options.num_soft_tokens_per_image),
    settings: { maxNewTokens: options.max_new_tokens, temperature: options.temperature, topP: options.top_p, doSample: options.do_sample },
    pastIsNull: options.past_key_values === null, returnDict: options.return_dict_in_generate,
    isTextStreamer: options.streamer instanceof runtime.TextStreamer, stoppingCriteriaType: typeof options.stopping_criteria,
  };
}

async function createGemmaInputReplay() {
  const inputs: number[][] = [];
  const nativeInputs: ReturnType<typeof captureGemmaNativeInput>[] = [];
  const harness = await createProviderReplayTestRuntime({
    imagePlatform: undefined,
    modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, cacheRevision: inputEvidence.revision, metadataCache: "all-fixture",
    // Native sessions use identifiable tiny bodies. The actual AutoModel,
    // AutoProcessor, tokenizer and offline resource path are not replaced.
    artifacts: [
      'onnx/audio_encoder_q4f16.onnx', 'onnx/audio_encoder_q4f16.onnx_data',
      'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
      'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
    ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
    generate: async context => {
      const input = captureGemmaNativeInput(context);
      nativeInputs.push(input);
      if (input.tensors.input_ids.isTensor) inputs.push(Array.from(input.tensors.input_ids.data, Number));
      // End at the native inference boundary: never supply tokens captured for
      // another input and never invent a successful model/tool response.
      throw new Error(INPUT_BOUNDARY);
    },
  });
  return { harness, inputs, verifyNativeInput() {
    expect(nativeInputs).toHaveLength(1);
    expect(harness.observations.inferenceCalls).toHaveLength(1);
    const native = nativeInputs[0];
    expect(native?.tensors.input_ids.isTensor).toBe(true);
    expect(native?.tensors.attention_mask.isTensor).toBe(true);
    if (!native?.tensors.input_ids.isTensor || !native.tensors.attention_mask.isTensor) throw new Error('Expected actual Gemma input and mask Tensors');
    const { input_ids: input, attention_mask: mask } = native.tensors;
    expect(input.type).toBe('int64');
    expect(input.location).toBe('cpu');
    expect(input.dims).toEqual([1, input.data.length]);
    expect(mask.type).toBe('int64');
    expect(mask.location).toBe('cpu');
    expect(mask.dims).toEqual(input.dims);
    expect(Array.from(mask.data, BigInt)).toEqual(Array.from(input.data, () => 1n));
  } };
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
async function createGemmaImageInputControl({ imageUrl, expectedRgba, expectedPixels }: {
  imageUrl: string, expectedRgba: Uint8ClampedArray, expectedPixels: Float32Array,
}) {
  const platform = createProviderReplayTestImagePlatform();
  const nativeInputs: ReturnType<typeof captureGemmaNativeInput>[] = [];
  const harness = await createProviderReplayTestRuntime({
    modelId: imageEvidence.modelId, expectedRevision: imageEvidence.revision, cacheRevision: imageEvidence.revision, metadataCache: "all-fixture",
    imagePlatform: { platform, allowedDataUrls: [imageUrl] },
    artifacts: [
      'onnx/audio_encoder_q4f16.onnx', 'onnx/audio_encoder_q4f16.onnx_data',
      'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
      'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
    ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: imageEvidence.modelId, revision: imageEvidence.revision, path }) })),
    generate: async context => {
      nativeInputs.push(captureGemmaNativeInput(context));
      // A browser pixel digest was not captured. Do not present independently
      // derived values as recorded bytes or release the original token "The"
      // merely because dimensions and text tokens happen to match.
      throw new Error(IMAGE_INPUT_BOUNDARY);
    },
  });
  return { harness, verifyNativeInput() {
    expect(nativeInputs).toHaveLength(1);
    const native = nativeInputs[0];
    if (!native) throw new Error('Expected actual Gemma image inference');
    const { input_ids, attention_mask, pixel_values, image_position_ids } = native.tensors;
    for (const tensor of Object.values(native.tensors)) expect(tensor.isTensor).toBe(true);
    if (!input_ids.isTensor || !attention_mask.isTensor || !pixel_values.isTensor || !image_position_ids.isTensor) throw new Error('Expected actual Gemma image Tensors');
    const tensors = { input_ids, attention_mask, pixel_values, image_position_ids };
    expect(native.softTokens).toEqual([256]);
    expect(native.optionKeys.sort()).toEqual([
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
    expect(native.settings).toEqual(imageEvidence.generationSettings);
    expect(native.pastIsNull).toBe(true);
    expect(native.returnDict).toBe(true);
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
  } };
}

describe('Gemma4 E2B Provider / basic', () => {
  it.each(inputEvidence.cases.filter(scenario => scenario.tools.length === 0))('$caseId reaches the exact recorded input through the public Provider', async scenario => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    const replay = await createGemmaInputReplay();
    try {
      capture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: scenario.messages,
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 1,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await expect(capture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      const chunks = observed.chunks;
      replay.verifyNativeInput();
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
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('delivers the recorded first-turn prefix through the actual processor and streamer before Provider settlement', async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    expect(generationEvidence.identity).toEqual({
      modelId: 'hf.co/onnx-community/gemma-4-E2B-it-ONNX',
      resolvedRevision: inputEvidence.revision,
      investigationRunId: 'e5891b08-6053-4092-87e5-47038836e431',
      transformersJsVersion: '4.2.0',
    });
    let releasedTokenCount = 0;
    const harness = await createProviderReplayTestRuntime({
      imagePlatform: undefined,
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, cacheRevision: inputEvidence.revision, metadataCache: "all-fixture",
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
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: generationEvidence.identity.modelId,
          messages: generationEvidence.scenario.messages,
          tools: [],
          parameters: {
            ...generationEvidence.scenario.lmParameters,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await capture.completion;
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'fulfilled' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      const chunks = observed.chunks;
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
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('basic: delivers the recorded first-turn callbacks before settlement', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn"],
      artifactPaths: ["onnx/audio_encoder_q4f16.onnx","onnx/audio_encoder_q4f16.onnx_data","onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"],
      imagePlatform: undefined,
    });
    const captures: ProviderChatCapture[] = [];
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 16,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: undefined,
        },
      };
      replay.beginNativeRequest({ caseId: "first-turn", parameters: parameters });
      const capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
          tools: [],
          parameters: parameters,
          signal: signal,
        },
      });
      captures.push(capture);
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      const { responses, preStartChunks: earlyChunks, toolCalls, toolResults, toolEvents } = observed;
      const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(responses.map(chunks => chunks.join(''))).toEqual(["Please provide the **context** or **purpose** of the \"template probe user"]);
      expect(earlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(order).toEqual(["assistant-start", "settled"]);
      expect(toolEvents).toEqual([]);
      expect(toolCalls).toEqual([]);
      expect(toolResults).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
});

describe('Gemma4 E2B Provider / system', () => {
  it('system: preserves instructions and delivers the recorded callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["system-user"],
      artifactPaths: ["onnx/audio_encoder_q4f16.onnx","onnx/audio_encoder_q4f16.onnx_data","onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"],
      imagePlatform: undefined,
    });
    const captures: ProviderChatCapture[] = [];
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 1,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: undefined,
        },
      };
      replay.beginNativeRequest({ caseId: "system-user", parameters: parameters });
      const capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "system",
              content: "Template probe system instruction.",
            },
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
          tools: [],
          parameters: parameters,
          signal: signal,
        },
      });
      captures.push(capture);
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      const { responses, preStartChunks: earlyChunks, toolCalls, toolResults, toolEvents } = observed;
      const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(responses.map(chunks => chunks.join(''))).toEqual(["Please"]);
      expect(earlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(order).toEqual(["assistant-start", "settled"]);
      expect(toolEvents).toEqual([]);
      expect(toolCalls).toEqual([]);
      expect(toolResults).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
});

describe('Gemma4 E2B Provider / history', () => {
  it('preserves the recorded turn delimiter and visible text in supplied-history continuation', async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
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
    const harness = await createProviderReplayTestRuntime({
      imagePlatform: undefined,
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, cacheRevision: inputEvidence.revision, metadataCache: "all-fixture",
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
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: continuity.identity.modelId,
          messages: continuity.scenario.messages,
          tools: [],
          parameters: {
            ...continuity.scenario.lmParameters,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await capture.completion;
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'fulfilled' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      const chunks = observed.chunks;
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
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('preserves the separate 16-token continuation capture without inferring why native generation stopped', async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
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
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, cacheRevision: inputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
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
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: budgetContinuity.identity.modelId,
          messages: budgetContinuity.scenario.messages,
          tools: [],
          parameters: {
            ...budgetContinuity.scenario.lmParameters,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await capture.completion;
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'fulfilled' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      const chunks = observed.chunks;
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
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('history: preserves supplied history and delivers the recorded callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["supplied-history"],
      artifactPaths: ["onnx/audio_encoder_q4f16.onnx","onnx/audio_encoder_q4f16.onnx_data","onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"],
      imagePlatform: undefined,
    });
    const captures: ProviderChatCapture[] = [];
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 1,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: undefined,
        },
      };
      replay.beginNativeRequest({ caseId: "supplied-history", parameters: parameters });
      const capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe first user message.",
            },
            {
              role: "assistant",
              content: "Template probe assistant response.",
            },
            {
              role: "user",
              content: "Template probe second user message.",
            },
          ],
          tools: [],
          parameters: parameters,
          signal: signal,
        },
      });
      captures.push(capture);
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      const { responses, preStartChunks: earlyChunks, toolCalls, toolResults, toolEvents } = observed;
      const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(responses.map(chunks => chunks.join(''))).toEqual(["Please"]);
      expect(earlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(order).toEqual(["assistant-start", "settled"]);
      expect(toolEvents).toEqual([]);
      expect(toolCalls).toEqual([]);
      expect(toolResults).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
});

describe('Gemma4 E2B Provider / independent', () => {
  it('keeps an independent next input free of prior text in the same null-KV loaded runtime', async () => {
    const captures: ProviderChatCapture[] = [];
    let firstCapture: ProviderChatCapture | undefined;
    let secondCapture: ProviderChatCapture | undefined;
    const nextMessages: ChatMessage[] = [
      {
        role: 'user',
        content: 'A separate synthetic Gemma conversation.',
      },
    ];
    const nextPrompt = `\
<bos><|turn>user
A separate synthetic Gemma conversation.<turn|>
<|turn>model
`;
    const stop = 'Independent Gemma next input verified; no second output supplied';
    const contexts: Parameters<ProviderReplayGenerate>[0][] = [];
    let firstReleased = 0;
    const stoppedInputs: ReturnType<typeof captureGemmaNativeInput>[] = [];
    const invocations: ProviderReplayGenerate[] = [
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
        stoppedInputs.push(captureGemmaNativeInput(context));
        // No captured response exists for this changed input. This tests input
        // isolation with null KV, not native KV invalidation or generation.
        throw new Error(stop);
      },
    ];
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, cacheRevision: inputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
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
      firstCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: generationEvidence.identity.modelId,
          messages: generationEvidence.scenario.messages,
          tools: [],
          parameters: {
            ...generationEvidence.scenario.lmParameters,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(firstCapture);
      await firstCapture.completion;
      const firstObserved = firstCapture.snapshot();
      expect(firstObserved.settlement).toMatchObject({ status: 'fulfilled' });
      expect(firstObserved.preStartChunks).toEqual([]);
      expect(firstObserved.responses).toHaveLength(1);
      expect(firstObserved.toolCalls).toEqual([]);
      expect(firstObserved.toolResults).toEqual([]);
      expect(firstObserved.toolEvents).toEqual([]);
      expect(firstObserved.lateEvents).toEqual([]);
      expect(firstObserved.chunks.join('')).toBe(generationEvidence.expectedProviderSemantic.visibleContent);
      const ortCountAfterFirst = harness.observations.ortCalls.length;
      expect(harness.observations.processors).toHaveLength(1);
      const processorAfterFirst = harness.observations.processors[0];
      secondCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: generationEvidence.identity.modelId,
          messages: nextMessages,
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 1,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(secondCapture);
      await expect(secondCapture.completion).rejects.toThrow(stop);
      const tokenizer = contexts[1]!.tokenizer;
      expect(stoppedInputs).toHaveLength(1);
      const native = stoppedInputs[0];
      expect(native?.tensors.input_ids.isTensor).toBe(true);
      expect(native?.tensors.attention_mask.isTensor).toBe(true);
      if (!native?.tensors.input_ids.isTensor || !native.tensors.attention_mask.isTensor) throw new Error('Expected actual next-input tensors');
      const { input_ids: input, attention_mask: mask } = native.tensors;
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe('781d10940fbc44be40064b5d43a056fc486c84ceaa55538226368b57314132bf');
      const processor = harness.observations.processors[0];
      if (!processor) throw new Error('Expected actual loaded Gemma processor');
      expect(tokenizer).toBe(processor.tokenizer);
      expect(processor.apply_chat_template(nextMessages, { add_generation_prompt: true })).toBe(nextPrompt);
      const ids = tokenizer.encode(nextPrompt, { add_special_tokens: false });
      expect(input.type).toBe('int64');
      expect(input.location).toBe('cpu');
      expect(input.dims).toEqual([1, ids.length]);
      expect(Array.from(input.data, Number)).toEqual(ids);
      expect(mask.type).toBe('int64');
      expect(mask.location).toBe('cpu');
      expect(mask.dims).toEqual([1, ids.length]);
      expect(Array.from(mask.data, BigInt)).toEqual(ids.map(() => 1n));
      expect(native.optionKeys.sort()).toEqual([
        'attention_mask', 'do_sample', 'input_ids', 'max_new_tokens', 'past_key_values',
        'return_dict_in_generate', 'stopping_criteria', 'streamer', 'temperature', 'top_p',
      ].sort());
      expect(native.settings)
        .toEqual({ maxNewTokens: 1, temperature: 0, topP: 1, doSample: false });
      expect(native.returnDict).toBe(true);
      expect(native.isTextStreamer).toBe(true);
      expect(native.stoppingCriteriaType).toBe('function');
      expect(native.pastIsNull).toBe(true);
      const secondObserved = secondCapture.snapshot();
      expect(secondObserved.settlement).toMatchObject({ status: 'rejected' });
      expect(secondObserved.preStartChunks).toEqual([]);
      expect(secondObserved.responses).toHaveLength(1);
      expect(secondObserved.toolCalls).toEqual([]);
      expect(secondObserved.toolResults).toEqual([]);
      expect(secondObserved.toolEvents).toEqual([]);
      expect(secondObserved.lateEvents).toEqual([]);
      const secondChunks = secondObserved.chunks;
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
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('independent: keeps a new conversation independent after settled requests in the same runtime', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn","continuity","independent-next-input"],
      artifactPaths: ["onnx/audio_encoder_q4f16.onnx","onnx/audio_encoder_q4f16.onnx_data","onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"],
      imagePlatform: undefined,
    });
    const captures: ProviderChatCapture[] = [];
    try {
      const firstSignal = new AbortController().signal;
      const firstParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 16,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: undefined,
        },
      };
      replay.beginNativeRequest({ caseId: "first-turn", parameters: firstParameters });
      const firstCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
          tools: [],
          parameters: firstParameters,
          signal: firstSignal,
        },
      });
      captures.push(firstCapture);
      await firstCapture.completion;
      replay.endNativeRequest();
      const firstObserved = firstCapture.snapshot();
      expect(firstObserved.settlement).toEqual({ status: 'fulfilled' });
      const { responses: firstResponses, preStartChunks: firstEarlyChunks, toolCalls: firstToolCalls, toolResults: firstToolResults, toolEvents: firstToolEvents } = firstObserved;
      const firstOrder = firstObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(firstResponses.map(chunks => chunks.join(''))).toEqual(["Please provide the **context** or **purpose** of the \"template probe user"]);
      expect(firstEarlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(firstOrder).toEqual(["assistant-start", "settled"]);
      expect(firstToolEvents).toEqual([]);
      expect(firstToolCalls).toEqual([]);
      expect(firstToolResults).toEqual([]);
      const nextSignal = new AbortController().signal;
      const nextParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 16,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: undefined,
        },
      };
      replay.beginNativeRequest({ caseId: "continuity", parameters: nextParameters });
      const nextCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
            {
              role: "assistant",
              content: firstResponses[0]!.join(''),
            },
            {
              role: "user",
              content: "Continue the synthetic conversation with a short response.",
            },
          ],
          tools: [],
          parameters: nextParameters,
          signal: nextSignal,
        },
      });
      captures.push(nextCapture);
      await nextCapture.completion;
      replay.endNativeRequest();
      const nextObserved = nextCapture.snapshot();
      expect(nextObserved.settlement).toEqual({ status: 'fulfilled' });
      const { responses: nextResponses, preStartChunks: nextEarlyChunks, toolCalls: nextToolCalls, toolResults: nextToolResults, toolEvents: nextToolEvents } = nextObserved;
      const nextOrder = nextObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(nextResponses.map(chunks => chunks.join(''))).toEqual(["Please provide the **previous part of the conversation** or the **topic** you"]);
      expect(nextEarlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(nextOrder).toEqual(["assistant-start", "settled"]);
      expect(nextToolEvents).toEqual([]);
      expect(nextToolCalls).toEqual([]);
      expect(nextToolResults).toEqual([]);
      const independentSignal = new AbortController().signal;
      const independentParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 1,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: undefined,
        },
      };
      replay.beginNativeRequest({ caseId: "independent-next-input", parameters: independentParameters });
      const independentCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "user",
              content: "A separate synthetic capture conversation.",
            },
          ],
          tools: [],
          parameters: independentParameters,
          signal: independentSignal,
        },
      });
      captures.push(independentCapture);
      await independentCapture.completion;
      replay.endNativeRequest();
      const independentObserved = independentCapture.snapshot();
      expect(independentObserved.settlement).toEqual({ status: 'fulfilled' });
      const { responses: independentResponses, preStartChunks: independentEarlyChunks, toolCalls: independentToolCalls, toolResults: independentToolResults, toolEvents: independentToolEvents } = independentObserved;
      const independentOrder = independentObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(independentResponses.map(chunks => chunks.join(''))).toEqual(["Please"]);
      expect(independentEarlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(independentOrder).toEqual(["assistant-start", "settled"]);
      expect(independentToolEvents).toEqual([]);
      expect(independentToolCalls).toEqual([]);
      expect(independentToolResults).toEqual([]);
      replay.assertComplete({ requests: 3, nativeCalls: 3 });
    } finally {
      await replay.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
});

describe('Gemma4 E2B Provider / reasoning', () => {
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
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    const replay = await createGemmaInputReplay();
    const messages = [
      {
        role: 'user',
        content: 'Template probe user message.',
      },
    ];
    try {
      await replay.harness.service.loadDownloadedModel({ modelId: inputEvidence.modelId });
      const processor = replay.harness.observations.processors[0]!;
      const tokenizer = processor.tokenizer;
      if (tokenizer === undefined) throw new Error('Expected actual selected tokenizer');
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe(toolInputEvidence.selectedTemplateSha256);
      const nativeOptions = { add_generation_prompt: true, enable_thinking: enableThinking };
      expect(processor.apply_chat_template(messages, nativeOptions)).toBe(expectedPrompt);
      const expectedIds = tokenizer.encode(expectedPrompt, { add_special_tokens: false });
      capture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages,
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 1,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort,
            },
          },
        },
      });
      captures.push(capture);
      await expect(capture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      const chunks = observed.chunks;
      expect(chunks, 'Input-only reasoning control must not release output').toEqual([]);
      replay.verifyNativeInput();
      expect(replay.inputs).toEqual([expectedIds]);
      expect(replay.harness.observations.inferenceCalls).toHaveLength(1);
      expect(replay.harness.observations.forbiddenTransport).toEqual([]);
      expect(replay.harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await replay.harness.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
      expect(capture?.snapshot().chunks, 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('reasoning: preserves the recorded none-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-none"],
      artifactPaths: ["onnx/audio_encoder_q4f16.onnx","onnx/audio_encoder_q4f16.onnx_data","onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"],
      imagePlatform: undefined,
    });
    const captures: ProviderChatCapture[] = [];
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 1,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: "none",
        },
      };
      replay.beginNativeRequest({ caseId: "reasoning-none", parameters: parameters });
      const capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
          tools: [],
          parameters: parameters,
          signal: signal,
        },
      });
      captures.push(capture);
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      const { responses, preStartChunks: earlyChunks, toolCalls, toolResults, toolEvents } = observed;
      const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(responses.map(chunks => chunks.join(''))).toEqual(["Please"]);
      expect(earlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(order).toEqual(["assistant-start", "settled"]);
      expect(toolEvents).toEqual([]);
      expect(toolCalls).toEqual([]);
      expect(toolResults).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('reasoning: preserves the recorded low-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-low"],
      artifactPaths: ["onnx/audio_encoder_q4f16.onnx","onnx/audio_encoder_q4f16.onnx_data","onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"],
      imagePlatform: undefined,
    });
    const captures: ProviderChatCapture[] = [];
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 1,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: "low",
        },
      };
      replay.beginNativeRequest({ caseId: "reasoning-low", parameters: parameters });
      const capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
          tools: [],
          parameters: parameters,
          signal: signal,
        },
      });
      captures.push(capture);
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      const { responses, preStartChunks: earlyChunks, toolCalls, toolResults, toolEvents } = observed;
      const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(responses.map(chunks => chunks.join(''))).toEqual([""]);
      expect(earlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(order).toEqual(["assistant-start", "settled"]);
      expect(toolEvents).toEqual([]);
      expect(toolCalls).toEqual([]);
      expect(toolResults).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('reasoning: preserves the recorded medium-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-medium"],
      artifactPaths: ["onnx/audio_encoder_q4f16.onnx","onnx/audio_encoder_q4f16.onnx_data","onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"],
      imagePlatform: undefined,
    });
    const captures: ProviderChatCapture[] = [];
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 1,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: "medium",
        },
      };
      replay.beginNativeRequest({ caseId: "reasoning-medium", parameters: parameters });
      const capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
          tools: [],
          parameters: parameters,
          signal: signal,
        },
      });
      captures.push(capture);
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      const { responses, preStartChunks: earlyChunks, toolCalls, toolResults, toolEvents } = observed;
      const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(responses.map(chunks => chunks.join(''))).toEqual([""]);
      expect(earlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(order).toEqual(["assistant-start", "settled"]);
      expect(toolEvents).toEqual([]);
      expect(toolCalls).toEqual([]);
      expect(toolResults).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('reasoning: preserves the recorded high-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-high"],
      artifactPaths: ["onnx/audio_encoder_q4f16.onnx","onnx/audio_encoder_q4f16.onnx_data","onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"],
      imagePlatform: undefined,
    });
    const captures: ProviderChatCapture[] = [];
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 1,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: "high",
        },
      };
      replay.beginNativeRequest({ caseId: "reasoning-high", parameters: parameters });
      const capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
          tools: [],
          parameters: parameters,
          signal: signal,
        },
      });
      captures.push(capture);
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      const { responses, preStartChunks: earlyChunks, toolCalls, toolResults, toolEvents } = observed;
      const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(responses.map(chunks => chunks.join(''))).toEqual([""]);
      expect(earlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(order).toEqual(["assistant-start", "settled"]);
      expect(toolEvents).toEqual([]);
      expect(toolCalls).toEqual([]);
      expect(toolResults).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
});

describe('Gemma4 E2B Provider / tools', () => {
  it('preserves a public tool definition in the native Gemma input instead of silently dropping it', async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
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
      capture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: scenario.messages,
          tools: [tool],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 1,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await expect(capture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.lateEvents).toEqual([]);
      const chunks = observed.chunks;
      expect(chunks, 'Input-only test must not emit generated content').toEqual([]);
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
      replay.verifyNativeInput();
      expect(replay.inputs).toEqual([scenario.inputTokenIds]);
    } finally {
      await replay.harness.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
      expect(capture?.snapshot().chunks, 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('retains structured tool-call and result association instead of flattening them into ordinary conversation text', async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
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

      capture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: scenario.modelId,
          messages: publicMessages,
          tools: [publicTool],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 1,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await expect(capture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.lateEvents).toEqual([]);
      const chunks = observed.chunks;
      expect(chunks).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(capture?.snapshot().toolCalls).toEqual([]);
      expect(capture?.snapshot().toolResults).toEqual([]);
      expect(replay.harness.observations.inferenceCalls).toHaveLength(1);
      expect(replay.harness.observations.localImageFetchCalls).toEqual([]);
      expect(replay.harness.observations.forbiddenTransport).toEqual([]);
      expect(replay.harness.observations.runtimeAssetFetchCalls).toEqual([replay.harness.observations.expectedRuntimeAssetUrl]);
      expect(replay.harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // Native role/ID/call delimiters are material here: replacing them with
      // plain assistant/user summaries is not merely a strict-schema difference.
      // Compare only after control and safety checks; no generated token is used.
      replay.verifyNativeInput();
      expect(replay.inputs).toEqual([expectedIds]);
    } finally {
      await replay.harness.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('executes a native-format synthetic tool call once and supplies its structured result to the next real processor input', async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    const executedArgs: unknown[] = [];
    const messages = [
      {
        role: 'user',
        content: 'Use the synthetic weather tool for Tokyo.',
      },
    ];
    const execute = vi.fn<Tool['execute']>(async ({ args }) => {
      executedArgs.push(structuredClone(args));
      return { status: 'success', content: 'Synthetic weather result: clear.' };
    });
    const tool: Tool = { name: 'lookup_weather', description: 'Return deterministic weather fixture data.', parametersSchema: z.object({ city: z.string() }), execute };
    const definition = { type: 'function', function: { name: tool.name, description: tool.description,
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } } };
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
        expect(capture?.snapshot().toolCalls).toHaveLength(1);
        const id = z.string().parse(capture?.snapshot().toolCalls[0]?.id);
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
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages,
          tools: [tool],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 128,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await capture.completion;
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'fulfilled' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(2);
      expect(observed.lateEvents).toEqual([]);
      const chunks = observed.chunks;
      expect(turns).toBe(2);
      expect(execute).toHaveBeenCalledOnce();
      expect(executedArgs).toEqual([{ city: 'Tokyo' }]);
      expect(capture?.snapshot().toolResults).toContainEqual(expect.objectContaining({ result: { status: 'success', content: 'Synthetic weather result: clear.' } }));
      expect(chunks.join('')).toBe('Synthetic final answer.');
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.inferenceCalls).toHaveLength(2);
      expect(harness.observations.processors).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('rejects an unfinished second native tool call without executing the earlier complete call', async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: 'Must not execute' }));
    const tool: Tool = { name: 'lookup_weather', description: 'Synthetic weather tool.', parametersSchema: z.object({ city: z.string() }), execute };
    const harness = await createGemmaSyntheticProtocolRuntime({ generate: async context => emitSyntheticGemmaProtocol({ context,
      text: '<|tool_call>call:lookup_weather{city:<|"|>Tokyo<|"|>}<tool_call|><|tool_call>call:lookup_weather{city:' }) });
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: [
            {
              role: 'user',
              content: 'Use the synthetic tool.',
            },
          ],
          tools: [tool],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 128,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await expect(capture.completion).rejects.toThrow(/Gemma.*tool.*protocol/i);
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.lateEvents).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(capture?.snapshot().toolCalls).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
    } finally {
      await harness.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it.each([
    { label: 'explicit null accepted by the registered tool schema', payload: 'value:null' },
    { label: 'an unsafe bare argument key accepted by the registered tool schema', payload: 'params:{unsafe:key:1}' },
    { label: 'an unbalanced native quote delimiter', payload: 'value:<|"|>first<|"|>second<|"|>' },
  ])('rejects $label before publishing or executing any call', async ({ payload }) => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: 'Must not execute' }));
    const tool: Tool = { name: 'capture_value', description: 'Accept a synthetic value.',
      parametersSchema: z.object({ value: z.null().optional(), params: z.object({}).catchall(z.number()).optional() }), execute };
    expect(tool.parametersSchema.strict().safeParse({ value: null }).success).toBe(true);
    expect(tool.parametersSchema.strict().safeParse({ params: { 'unsafe:key': 1 } }).success).toBe(true);
    expect(tool.parametersSchema.strict().safeParse({}).success).toBe(true);
    const harness = await createGemmaSyntheticProtocolRuntime({ generate: async context => emitSyntheticGemmaProtocol({ context,
      text: `<|tool_call>call:capture_value{}<tool_call|><|tool_call>call:capture_value{${payload}}<tool_call|>` }) });
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: [
            {
              role: 'user',
              content: 'Use the synthetic tool.',
            },
          ],
          tools: [tool],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 128,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await expect(capture.completion).rejects.toThrow(/Gemma.*(?:tool.*protocol|template)/i);
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.lateEvents).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(capture?.snapshot().toolCalls).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
    } finally {
      await harness.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('reports an unknown native tool name without executing a registered tool and continues with the actual error result input', async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
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
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: [
            {
              role: 'user',
              content: 'Use the synthetic tool.',
            },
          ],
          tools: [tool],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 128,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await capture.completion;
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'fulfilled' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(2);
      expect(observed.lateEvents).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(capture?.snapshot().toolResults).toContainEqual(expect.objectContaining({ result: { status: 'error', code: 'other', message: 'Tool "unknown_tool" not found.' } }));
      expect(harness.observations.inferenceCalls).toHaveLength(2);
      expect(harness.observations.forbiddenTransport).toEqual([]);
    } finally {
      await harness.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('rejects a lossy tool result after its one actual execution and before the next native inference', async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: 'Synthetic result<|"|>delimiter' }));
    const tool: Tool = { name: 'capture_value', description: 'Synthetic tool result.', parametersSchema: z.object({ value: z.number() }), execute };
    const harness = await createGemmaSyntheticProtocolRuntime({ generate: async context => emitSyntheticGemmaProtocol({ context,
      text: '<|tool_call>call:capture_value{value:1}<tool_call|>' }) });
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: [
            {
              role: 'user',
              content: 'Use the synthetic tool.',
            },
          ],
          tools: [tool],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 128,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await expect(capture.completion).rejects.toThrow('quote delimiter');
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.preStartChunks).toEqual([]);
      // The Provider starts its second response before prompt preparation
      // rejects the result; this does not imply a second native inference.
      expect(observed.responses).toEqual([[], []]);
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind))
        .toEqual(['assistant-start', 'tool-call', 'tool-result', 'assistant-start', 'settled']);
      expect(observed.lateEvents).toEqual([]);
      expect(execute).toHaveBeenCalledOnce();
      expect(capture?.snapshot().toolResults).toHaveLength(1);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
    } finally {
      await harness.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('tools: executes the recorded minimal Tokyo call once and continues with its result', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["natural-tool-minimal"],
      artifactPaths: ["onnx/audio_encoder_q4f16.onnx","onnx/audio_encoder_q4f16.onnx_data","onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"],
      imagePlatform: undefined,
    });
    const captures: ProviderChatCapture[] = [];
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 128,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: undefined,
        },
      };
      const executedSignals: Array<AbortSignal | undefined> = [];
      const executedArgs: unknown[] = [];
      const execute = vi.fn<Tool['execute']>(async ({ args, signal }) => {
        executedArgs.push(structuredClone(args));
        executedSignals.push(signal);
        return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
      });
      const tools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.", parametersSchema: z.object({ city: z.string() }), execute: execute }];
      replay.beginNativeRequest({ caseId: "natural-tool-minimal", parameters: parameters });
      const capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "user",
              content: "Use the weather tool for Tokyo.",
            },
          ],
          tools: tools,
          parameters: parameters,
          signal: signal,
        },
      });
      captures.push(capture);
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      const { responses, preStartChunks: earlyChunks, toolCalls, toolResults, toolEvents } = observed;
      const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(responses.map(chunks => chunks.join(''))).toEqual(["", "The weather in Tokyo is clear with a temperature of 20°C."]);
      expect(earlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(order).toEqual(["assistant-start", "tool-call", "tool-result", "assistant-start", "settled"]);
      expect(toolEvents).toEqual([]);
      expect(executedArgs).toEqual([{ city: 'Tokyo' }]);
      expect(execute).toHaveBeenCalledOnce();
      expect(executedSignals).toHaveLength(1);
      expect(executedSignals[0]).toBe(signal);
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toEqual({ id: expect.any(String), toolName: 'lookup_weather', modelVisibleArguments: '{"city":"Tokyo"}' });
      expect(toolResults).toEqual([{  id: toolCalls[0]!.id, result: { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }  }]);
      replay.assertComplete({ requests: 1, nativeCalls: 2 });
    } finally {
      await replay.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('tools: executes the recorded representative Tokyo call once and continues with its result', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["natural-tool-representative"],
      artifactPaths: ["onnx/audio_encoder_q4f16.onnx","onnx/audio_encoder_q4f16.onnx_data","onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"],
      imagePlatform: undefined,
    });
    const captures: ProviderChatCapture[] = [];
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 128,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: undefined,
        },
      };
      const executedSignals: Array<AbortSignal | undefined> = [];
      const executedArgs: unknown[] = [];
      const execute = vi.fn<Tool['execute']>(async ({ args, signal }) => {
        executedArgs.push(structuredClone(args));
        executedSignals.push(signal);
        return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
      });
      const tools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.", parametersSchema: z.object({ city: z.string() }), execute: execute }];
      replay.beginNativeRequest({ caseId: "natural-tool-representative", parameters: parameters });
      const capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "user",
              content: "Use lookup_weather for Tokyo, then give a short answer based on the tool result.",
            },
          ],
          tools: tools,
          parameters: parameters,
          signal: signal,
        },
      });
      captures.push(capture);
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      const { responses, preStartChunks: earlyChunks, toolCalls, toolResults, toolEvents } = observed;
      const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(responses.map(chunks => chunks.join(''))).toEqual(["", "The weather in Tokyo is clear with a temperature of 20°C."]);
      expect(earlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(order).toEqual(["assistant-start", "tool-call", "tool-result", "assistant-start", "settled"]);
      expect(toolEvents).toEqual([]);
      expect(executedArgs).toEqual([{ city: 'Tokyo' }]);
      expect(execute).toHaveBeenCalledOnce();
      expect(executedSignals).toHaveLength(1);
      expect(executedSignals[0]).toBe(signal);
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toEqual({ id: expect.any(String), toolName: 'lookup_weather', modelVisibleArguments: '{"city":"Tokyo"}' });
      expect(toolResults).toEqual([{  id: toolCalls[0]!.id, result: { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }  }]);
      replay.assertComplete({ requests: 1, nativeCalls: 2 });
    } finally {
      await replay.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('tools: preserves structured caller history and the recorded response', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["structured-tool-history"],
      artifactPaths: ["onnx/audio_encoder_q4f16.onnx","onnx/audio_encoder_q4f16.onnx_data","onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"],
      imagePlatform: undefined,
    });
    const captures: ProviderChatCapture[] = [];
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 128,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: undefined,
        },
      };
      const executedSignals: Array<AbortSignal | undefined> = [];
      const executedArgs: unknown[] = [];
      const execute = vi.fn<Tool['execute']>(async ({ args, signal }) => {
        executedArgs.push(structuredClone(args));
        executedSignals.push(signal);
        return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
      });
      const tools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.", parametersSchema: z.object({ city: z.string() }), execute: execute }];
      replay.beginNativeRequest({ caseId: "structured-tool-history", parameters: parameters });
      const capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "user",
              content: "Use the weather tool for Tokyo.",
            },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: toToolCallId({ raw: "call_model_support_probe_1" }),
                  type: "function",
                  function: {
                    name: "lookup_weather",
                    arguments: "{\"city\":\"Tokyo\"}",
                  },
                },
              ],
            },
            {
              role: "tool",
              content: "{\"temperatureC\":20,\"condition\":\"clear\"}",
              tool_call_id: toToolCallId({ raw: "call_model_support_probe_1" }),
            },
          ],
          tools: tools,
          parameters: parameters,
          signal: signal,
        },
      });
      captures.push(capture);
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      const { responses, preStartChunks: earlyChunks, toolCalls, toolResults, toolEvents } = observed;
      const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(responses.map(chunks => chunks.join(''))).toEqual(["The weather in Tokyo is clear with a temperature of 20°C."]);
      expect(earlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(order).toEqual(["assistant-start", "settled"]);
      expect(toolEvents).toEqual([]);
      expect(toolCalls).toEqual([]);
      expect(toolResults).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
});

describe('Gemma4 E2B Provider / images', () => {
  it('matches the captured token/shape facts and independently derived black pixels through actual RawImage and processor', async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    const imageUrl = imageEvidence.messages[0].content[1].image_url.url;
    const bytes = Buffer.from(imageUrl.split(',')[1]!, 'base64');
    expect(bytes.length).toBe(imageEvidence.image.byteLength);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(imageEvidence.image.sha256);
    // The legacy fixture name said "transparent", but its actual pixel is opaque black.
    {
      const control = await createGemmaImageInputControl({
        imageUrl, expectedRgba: Uint8ClampedArray.of(0, 0, 0, 255), expectedPixels: new Float32Array(2520 * 768),
      });
      try {
        capture = captureProviderChat({
          provider: control.harness.provider,
          request: {
            model: "onnx-community/gemma-4-E2B-it-ONNX",
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: "text",
                    text: "Describe the single synthetic image in one short phrase.",
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: imageUrl,
                    },
                  },
                ],
              },
            ],
            tools: [],
            parameters: {
              temperature: 0,
              topP: 1,
              maxCompletionTokens: 1,
              presencePenalty: undefined,
              frequencyPenalty: undefined,
              stop: undefined,
              reasoning: {
                effort: undefined,
              },
            },
          },
        });
        captures.push(capture);
        await expect(capture.completion).rejects.toThrow(IMAGE_INPUT_BOUNDARY);
        const observed = capture.snapshot();
        expect(observed.settlement).toMatchObject({ status: 'rejected' });
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.responses).toHaveLength(1);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        const chunks = observed.chunks;
        expect(chunks.join('')).toBe('');
        expect(chunks).toEqual([]);
        expect(capture?.snapshot().toolCalls).toEqual([]);
        expect(capture?.snapshot().toolResults).toEqual([]);
        expect(capture?.snapshot().toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
        control.verifyNativeInput();
      } finally {
        await control.harness.close();
        expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);

      }
    }
  }, 30_000);
  it('changes every real pixel for a synthetic white image while retaining zero padding and the same geometry', async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    // Independently encoded 1x1 grayscale-alpha white PNG, not browser Evidence.
    // All 2304 real patches rescale 255 to 1; 216 padding patches remain zero.
    const expectedPixels = new Float32Array(2520 * 768);
    expectedPixels.fill(1, 0, 2304 * 768);
    {
      const control = await createGemmaImageInputControl({
        imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII=',
        expectedRgba: Uint8ClampedArray.of(255, 255, 255, 255), expectedPixels,
      });
      try {
        capture = captureProviderChat({
          provider: control.harness.provider,
          request: {
            model: "onnx-community/gemma-4-E2B-it-ONNX",
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: "text",
                    text: "Describe the single synthetic image in one short phrase.",
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII=',
                    },
                  },
                ],
              },
            ],
            tools: [],
            parameters: {
              temperature: 0,
              topP: 1,
              maxCompletionTokens: 1,
              presencePenalty: undefined,
              frequencyPenalty: undefined,
              stop: undefined,
              reasoning: {
                effort: undefined,
              },
            },
          },
        });
        captures.push(capture);
        await expect(capture.completion).rejects.toThrow(IMAGE_INPUT_BOUNDARY);
        const observed = capture.snapshot();
        expect(observed.settlement).toMatchObject({ status: 'rejected' });
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.responses).toHaveLength(1);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        const chunks = observed.chunks;
        expect(chunks.join('')).toBe('');
        expect(chunks).toEqual([]);
        expect(capture?.snapshot().toolCalls).toEqual([]);
        expect(capture?.snapshot().toolResults).toEqual([]);
        expect(capture?.snapshot().toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
        control.verifyNativeInput();
      } finally {
        await control.harness.close();
        expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);

      }
    }
  }, 30_000);
  it('images: preserves recorded pixels and processor tensors before delivering recorded callbacks', async () => {
    const platform = createProviderReplayTestImagePlatform();
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["image"],
      artifactPaths: ["onnx/audio_encoder_q4f16.onnx","onnx/audio_encoder_q4f16.onnx_data","onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"],
      imagePlatform: {
        platform,
        allowedDataUrls: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='],
      },
    });
    const captures: ProviderChatCapture[] = [];
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 1,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: undefined,
        },
      };
      replay.beginNativeRequest({ caseId: "image", parameters: parameters });
      const capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Describe the single synthetic image in one short phrase.",
                },
                {
                  type: "image_url",
                  image_url: {
                    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                  },
                },
              ],
            },
          ],
          tools: [],
          parameters: parameters,
          signal: signal,
        },
      });
      captures.push(capture);
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      const { responses, preStartChunks: earlyChunks, toolCalls, toolResults, toolEvents } = observed;
      const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(responses.map(chunks => chunks.join(''))).toEqual(["The"]);
      expect(earlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(order).toEqual(["assistant-start", "settled"]);
      expect(toolEvents).toEqual([]);
      expect(toolCalls).toEqual([]);
      expect(toolResults).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
});

describe('Gemma4 E2B Provider / sequences', () => {
  it('uses only the settled first callback text for a second request in the same loaded runtime', async () => {
    const captures: ProviderChatCapture[] = [];
    let firstCapture: ProviderChatCapture | undefined;
    let secondCapture: ProviderChatCapture | undefined;
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
    const contexts: Parameters<ProviderReplayGenerate>[0][] = [];
    const released: number[] = [];
    const invocations: ProviderReplayGenerate[] = [
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
    const harness = await createProviderReplayTestRuntime({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX', expectedRevision: generationEvidence.identity.resolvedRevision, cacheRevision: generationEvidence.identity.resolvedRevision, metadataCache: "all-fixture", imagePlatform: undefined,
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
      firstCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: generationEvidence.identity.modelId,
          messages: generationEvidence.scenario.messages,
          tools: [],
          parameters: {
            ...generationEvidence.scenario.lmParameters,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(firstCapture);
      await firstCapture.completion;
      const firstObserved = firstCapture.snapshot();
      expect(firstObserved.settlement).toMatchObject({ status: 'fulfilled' });
      expect(firstObserved.preStartChunks).toEqual([]);
      expect(firstObserved.responses).toHaveLength(1);
      expect(firstObserved.toolCalls).toEqual([]);
      expect(firstObserved.toolResults).toEqual([]);
      expect(firstObserved.toolEvents).toEqual([]);
      expect(firstObserved.lateEvents).toEqual([]);
      const firstChunks = firstObserved.chunks;
      // Immutable at settlement: late first callbacks cannot rewrite the next
      // request. There is no timer, callback drain, or artificial callback ACK.
      const firstTextAtSettlement = firstChunks.join('');
      const ortCountAfterFirst = harness.observations.ortCalls.length;
      expect(harness.observations.processors).toHaveLength(1);
      const processorAfterFirst = harness.observations.processors[0];
      let secondOutcome: { status: 'fulfilled' } | { status: 'rejected', error: unknown };
      try {
        secondCapture = captureProviderChat({
          provider: harness.provider,
          request: {
            model: generationEvidence.identity.modelId,
            messages: [
              ...generationEvidence.scenario.messages,
              {
                role: 'assistant',
                content: firstTextAtSettlement,
              },
              {
                role: 'user',
                content: 'Continue with one short sentence.',
              },
            ],
            tools: [],
            parameters: {
              ...continuity.scenario.lmParameters,
              presencePenalty: undefined,
              frequencyPenalty: undefined,
              stop: undefined,
              reasoning: {
                effort: undefined,
              },
            },
          },
        });
        captures.push(secondCapture);
        await secondCapture.completion;
        secondOutcome = { status: 'fulfilled' };
      } catch (error) {
        secondOutcome = { status: 'rejected', error };
      }
      // The collector's completion and detached snapshot own settlement;
      // cleanup below separately checks for later delivered callbacks.
      const secondObserved = secondCapture?.snapshot();
      expect(secondObserved?.settlement).toMatchObject({ status: 'fulfilled' });
      expect(secondObserved?.preStartChunks).toEqual([]);
      expect(secondObserved?.responses).toHaveLength(1);
      expect(secondObserved?.toolCalls).toEqual([]);
      expect(secondObserved?.toolResults).toEqual([]);
      expect(secondObserved?.toolEvents).toEqual([]);
      expect(secondObserved?.lateEvents).toEqual([]);
      const secondTextAtSettlement = secondObserved?.chunks.join('');
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
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('sequences: builds continuation from actually delivered first-request settlement', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn","continuity"],
      artifactPaths: ["onnx/audio_encoder_q4f16.onnx","onnx/audio_encoder_q4f16.onnx_data","onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"],
      imagePlatform: undefined,
    });
    const captures: ProviderChatCapture[] = [];
    try {
      const firstSignal = new AbortController().signal;
      const firstParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 16,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: undefined,
        },
      };
      replay.beginNativeRequest({ caseId: "first-turn", parameters: firstParameters });
      const firstCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
          tools: [],
          parameters: firstParameters,
          signal: firstSignal,
        },
      });
      captures.push(firstCapture);
      await firstCapture.completion;
      replay.endNativeRequest();
      const firstObserved = firstCapture.snapshot();
      expect(firstObserved.settlement).toEqual({ status: 'fulfilled' });
      const { responses: firstResponses, preStartChunks: firstEarlyChunks, toolCalls: firstToolCalls, toolResults: firstToolResults, toolEvents: firstToolEvents } = firstObserved;
      const firstOrder = firstObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(firstResponses.map(chunks => chunks.join(''))).toEqual(["Please provide the **context** or **purpose** of the \"template probe user"]);
      expect(firstEarlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(firstOrder).toEqual(["assistant-start", "settled"]);
      expect(firstToolEvents).toEqual([]);
      expect(firstToolCalls).toEqual([]);
      expect(firstToolResults).toEqual([]);
      const nextSignal = new AbortController().signal;
      const nextParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 16,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: {
          effort: undefined,
        },
      };
      replay.beginNativeRequest({ caseId: "continuity", parameters: nextParameters });
      const nextCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/gemma-4-E2B-it-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
            {
              role: "assistant",
              content: firstResponses[0]!.join(''),
            },
            {
              role: "user",
              content: "Continue the synthetic conversation with a short response.",
            },
          ],
          tools: [],
          parameters: nextParameters,
          signal: nextSignal,
        },
      });
      captures.push(nextCapture);
      await nextCapture.completion;
      replay.endNativeRequest();
      const nextObserved = nextCapture.snapshot();
      expect(nextObserved.settlement).toEqual({ status: 'fulfilled' });
      const { responses: nextResponses, preStartChunks: nextEarlyChunks, toolCalls: nextToolCalls, toolResults: nextToolResults, toolEvents: nextToolEvents } = nextObserved;
      const nextOrder = nextObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
      expect(nextResponses.map(chunks => chunks.join(''))).toEqual(["Please provide the **previous part of the conversation** or the **topic** you"]);
      expect(nextEarlyChunks).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
      expect(nextOrder).toEqual(["assistant-start", "settled"]);
      expect(nextToolEvents).toEqual([]);
      expect(nextToolCalls).toEqual([]);
      expect(nextToolResults).toEqual([]);
      replay.assertComplete({ requests: 2, nativeCalls: 2 });
    } finally {
      await replay.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('preserves thirteen requests including natural tools and actual image processor tensors in one Load', async () => {
    const fullEvidenceJson = assembleProviderSequenceEvidence({ catalog: providerReplayCatalog });
    expect(fullEvidenceJson.modelId).toBe('onnx-community/gemma-4-E2B-it-ONNX');
    expect(fullEvidenceJson.metadataRevision).toBe('9f4bef82ea6e296bc69f8a2f5939f73af81b07a6');
    expect(fullEvidenceJson.observedCacheRevision).toBe('9f4bef82ea6e296bc69f8a2f5939f73af81b07a6');
    const platform = createProviderReplayTestImagePlatform();
    await verifyCapturedFullReplay({ unavailableOutputs: [], completeResult: undefined, expectedLoadReceipt: undefined, evidence: fullEvidenceJson,
      reviewedPublicContract: undefined,
      imagePlatform: { platform, allowedDataUrls: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='] },
      artifactPaths: ['onnx/audio_encoder_q4f16.onnx', 'onnx/audio_encoder_q4f16.onnx_data', 'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data', 'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data', 'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data'],
    });
    expect(platform.observations.decodes).toHaveLength(1);
  }, 30_000);
});
