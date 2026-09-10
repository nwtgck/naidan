import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
// eslint-disable-next-line no-restricted-imports -- External streamer signature at the replaced native inference boundary; no runtime import.
import type { TextStreamer } from '@huggingface/transformers';

const tokenIdsSchema = z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const tensorFactSchema = z.object({
  name: z.enum(['input_ids', 'attention_mask']),
  dtype: z.literal('int64'), dims: z.tuple([z.literal(1), z.number().int().positive()]),
  location: z.literal('cpu'),
}).strict();
const requestedSettingsSchema = z.object({
  maxNewTokens: z.number().int().positive(), temperature: z.number(),
  topP: z.number(), doSample: z.boolean(),
}).strict();

// This is the recorded stateless text boundary, not a universal conversation
// schema. Images, KV reuse and natural tool completion require their own facts.
const textEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  identity: z.object({
    modelId: z.string().min(1), resolvedRevision: z.string().regex(/^[a-f0-9]{40}$/u),
    investigationRunId: z.string().min(1), transformersJsVersion: z.string().min(1),
  }).strict(),
  scenario: z.object({
    id: z.string().min(1),
    messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()).min(1),
    tools: z.array(z.never()).max(0),
    lmParameters: z.object({ temperature: z.number(), topP: z.number(), maxCompletionTokens: z.number().int().positive() }).strict(),
    // Legacy captures either exhaust the requested count or record a shorter
    // ending. Neither records the native stop cause. Do not promote the count
    // or last token into an observed EOS/max-token termination mechanism.
    boundary: z.discriminatedUnion('kind', [z.object({
      kind: z.literal('natural-prefix'), lengthRelation: z.literal('equals-requested-budget'),
      stopCause: z.literal('not-recorded'),
    }).strict(), z.object({
      kind: z.literal('recorded-ending'), lengthRelation: z.literal('below-requested-budget'),
      lastTokenId: z.number().int().nonnegative().safe(), stopCause: z.literal('not-recorded'),
    }).strict()]),
  }).strict(),
  inputContract: z.object({
    renderedPrompt: z.string().optional(), inputTokenIds: tokenIdsSchema.min(1),
    inputTensorFacts: z.array(tensorFactSchema).length(2),
    // Legacy MSI records four requested settings, not all actual kwargs after
    // budget clipping, model defaults, processors and stopping criteria.
    effectiveGenerationConfig: requestedSettingsSchema,
  }).strict(),
  modelReplay: z.object({
    source: z.literal('production-lane'), sourceInputTokenIds: tokenIdsSchema.min(1),
    sourceInputSha256: z.string().regex(/^[a-f0-9]{64}$/u), generatedTokenIds: tokenIdsSchema.min(1),
    generatedSequenceTokenIds: tokenIdsSchema.optional(), generatedText: z.string(),
  }).strict(),
  expectedProviderSemantic: z.object({
    basis: z.enum(['production-positive-control', 'native-template-contract']), captureScope: z.enum(['prefix', 'recorded-output']),
    visibleContent: z.string(), thinking: z.string().optional(),
  }).strict(),
}).strict();

export type ProductionReplayTextEvidence = z.infer<typeof textEvidenceSchema>;

function requireExact({ label, actual, expected }: { label: string, actual: unknown, expected: unknown }): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`Replay causal mismatch: ${label}`);
}

export function parseProductionReplayTextEvidence({ value }: { value: unknown }): ProductionReplayTextEvidence {
  const evidence = textEvidenceSchema.parse(value);
  const { inputContract, modelReplay, scenario } = evidence;
  requireExact({ label: 'recorded source digest', actual: createHash('sha256').update(JSON.stringify(modelReplay.sourceInputTokenIds)).digest('hex'), expected: modelReplay.sourceInputSha256 });
  requireExact({ label: 'recorded source input', actual: modelReplay.sourceInputTokenIds, expected: inputContract.inputTokenIds });
  requireExact({ label: 'recorded tensor names', actual: inputContract.inputTensorFacts.map(fact => fact.name).sort(), expected: ['attention_mask', 'input_ids'] });
  for (const fact of inputContract.inputTensorFacts) {
    requireExact({ label: 'recorded tensor dimensions', actual: fact.dims, expected: [1, modelReplay.sourceInputTokenIds.length] });
  }
  requireExact({ label: 'recorded request settings', actual: inputContract.effectiveGenerationConfig, expected: {
    maxNewTokens: scenario.lmParameters.maxCompletionTokens, temperature: scenario.lmParameters.temperature,
    topP: scenario.lmParameters.topP, doSample: scenario.lmParameters.temperature > 0,
  } });
  const boundary = scenario.boundary;
  switch (boundary.kind) {
  case 'natural-prefix':
    requireExact({ label: 'recorded prefix limit', actual: modelReplay.generatedTokenIds.length, expected: inputContract.effectiveGenerationConfig.maxNewTokens });
    requireExact({ label: 'recorded prefix scope', actual: evidence.expectedProviderSemantic.captureScope, expected: 'prefix' });
    break;
  case 'recorded-ending':
    if (modelReplay.generatedTokenIds.length >= inputContract.effectiveGenerationConfig.maxNewTokens) {
      throw new Error('Replay causal mismatch: recorded ending must precede request budget');
    }
    requireExact({ label: 'recorded last token', actual: modelReplay.generatedTokenIds.at(-1), expected: boundary.lastTokenId });
    requireExact({ label: 'recorded ending scope', actual: evidence.expectedProviderSemantic.captureScope, expected: 'recorded-output' });
    break;
  default: {
    const _ex: never = boundary;
    throw new Error(`Unsupported recorded boundary: ${_ex}`);
  }
  }
  if (modelReplay.generatedSequenceTokenIds !== undefined) {
    requireExact({ label: 'recorded decoder sequence', actual: modelReplay.generatedSequenceTokenIds, expected: [...modelReplay.sourceInputTokenIds, ...modelReplay.generatedTokenIds] });
  }
  return evidence;
}

const nativeTensorSchema = z.object({
  type: z.literal('int64'), dims: z.tuple([z.literal(1), z.number().int().positive()]),
  data: z.instanceof(BigInt64Array), location: z.literal('cpu'),
});

/**
 * Release recorded text only after checking its causal input. This lane
 * uses synchronous token steps intentionally; it must not sleep/drain to hide
 * missing callbacks at Provider settlement. It does not model GPU scheduling
 * or infer which native stopping mechanism ended the recorded sequence.
 */
export function replayRecordedText({ evidence, options }: {
  evidence: ProductionReplayTextEvidence,
  options: Record<string, unknown>,
}): { sequenceTokenIds: bigint[], releasedTokenCount: number } {
  // Revalidate on every invocation, including after a caller mutates a fixture.
  const checked = parseProductionReplayTextEvidence({ value: evidence });
  requireExact({ label: 'unrecorded generation options', actual: Object.keys(options).sort(), expected: [
    'attention_mask', 'do_sample', 'input_ids', 'max_new_tokens', 'past_key_values',
    'return_dict_in_generate', 'stopping_criteria', 'streamer', 'temperature', 'top_p',
  ].sort() });
  const input = nativeTensorSchema.parse(options['input_ids']);
  const mask = nativeTensorSchema.parse(options['attention_mask']);
  const tensors = { input_ids: input, attention_mask: mask };
  const sourceIds = checked.modelReplay.sourceInputTokenIds.map(BigInt);
  requireExact({ label: 'actual source input', actual: Array.from(input.data), expected: sourceIds });
  // Unpadded one-row text inputs use a full attention mask. This is an explicit
  // lane restriction, not an observation of arbitrary model attention tensors.
  requireExact({ label: 'unpadded attention mask', actual: Array.from(mask.data), expected: sourceIds.map(() => 1n) });
  for (const fact of checked.inputContract.inputTensorFacts) {
    const tensor = tensors[fact.name];
    requireExact({ label: 'actual tensor facts', actual: { name: fact.name, dtype: tensor.type, dims: tensor.dims, location: tensor.location }, expected: fact });
  }
  requireExact({ label: 'actual requested settings', actual: {
    maxNewTokens: options['max_new_tokens'], temperature: options['temperature'],
    topP: options['top_p'], doSample: options['do_sample'],
  }, expected: checked.inputContract.effectiveGenerationConfig });
  if (options['past_key_values'] !== undefined && options['past_key_values'] !== null) throw new Error('Replay evidence gap: KV-cache input');
  requireExact({ label: 'dictionary generate return contract', actual: options['return_dict_in_generate'], expected: true });
  const streamer = z.object({ put: z.custom<TextStreamer['put']>(value => typeof value === 'function'), end: z.custom<TextStreamer['end']>(value => typeof value === 'function') }).parse(options['streamer']);
  const stopping = options['stopping_criteria'];
  if (typeof stopping !== 'function') throw new Error('Replay requires actual callable stopping criteria');
  const sequenceTokenIds = [...sourceIds];
  let releasedTokenCount = 0;
  // Preserve the actual streamer receiver; Zod's parsed object is not the
  // callable's class instance and must never become a replacement streamer.
  Reflect.apply(streamer.put, options['streamer'], [[sourceIds]]);
  for (const tokenId of checked.modelReplay.generatedTokenIds) {
    sequenceTokenIds.push(BigInt(tokenId));
    Reflect.apply(streamer.put, options['streamer'], [[[BigInt(tokenId)]]]);
    releasedTokenCount += 1;
    const stopped = z.tuple([z.boolean()]).parse(Reflect.apply(stopping, undefined, [[sequenceTokenIds], undefined]));
    if (stopped[0]) break;
  }
  Reflect.apply(streamer.end, options['streamer'], []);
  return { sequenceTokenIds, releasedTokenCount };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
