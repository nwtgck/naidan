/* eslint-disable no-restricted-imports -- Uses the same bundled runtime's class identities, never an internal second runtime. */
// Resource-selection rules and class registrations are adapted from
// @huggingface/transformers 4.2.0, Apache-2.0; see upstream-resource-contract.LICENSE.
import * as runtime from '@huggingface/transformers';
import { z } from 'zod';
import contract from './upstream-resource-contract.json';
import { ProductionResourceCandidateError } from './production-resource-plan';
import type { TransformersJsProductionInvestigationCandidate, TransformersJsProductionInvestigationAutoClass } from '@/features/transformers-js/types';

const candidateSchema = z.object({ device: z.enum(['webgpu', 'wasm']), dtype: z.enum(['q4f16', 'q4']) }).strict();
const configSchema = z.object({
  model_type: z.string(),
  architectures: z.array(z.string()).nullish(),
  is_encoder_decoder: z.boolean().nullish(),
  'transformers.js_config': z.record(z.string(), z.unknown()).nullish(),
}).passthrough();
const familySchema = z.enum([
  'EncoderOnly', 'EncoderDecoder', 'Seq2Seq', 'Vision2Seq', 'DecoderOnly', 'DecoderOnlyWithoutHead',
  'MaskGeneration', 'ImageTextToText', 'Musicgen', 'MultiModality', 'Phi3V', 'AudioTextToText',
  'AutoEncoder', 'ImageAudioTextToText', 'Supertonic', 'Chatterbox', 'VoxtralRealtime',
]);
type Family = z.infer<typeof familySchema>;
const externalCountSchema = z.union([z.boolean(), z.number().int().min(0).max(100)]);

export interface ProductionResourceSession {
  key: string;
  baseName: string;
  corePath: string;
  externalData: Array<{ path: string; bindingPath: string }>;
  device: TransformersJsProductionInvestigationCandidate['device'];
  dtype: TransformersJsProductionInvestigationCandidate['dtype'];
}

// Versioned compatibility code for generic from_pretrained resource selection.
// The checked-in native-class table covers all upstream registrations, including
// architectures outside our selected AutoClasses. CI compares source hashes and
// actual web-loader requests independently; updating this data is not an oracle.
function sessionsForFamily({ family, textOnly, encoderDecoder }: {
  family: Family, textOnly: boolean, encoderDecoder: boolean,
}): Record<string, string> {
  switch (family) {
  case 'EncoderOnly':
  case 'DecoderOnly':
  case 'DecoderOnlyWithoutHead': return { model: 'model' };
  case 'EncoderDecoder':
  case 'Seq2Seq':
  case 'Vision2Seq': return { model: 'encoder_model', decoder_model_merged: 'decoder_model_merged' };
  case 'MaskGeneration': return { model: 'vision_encoder', prompt_encoder_mask_decoder: 'prompt_encoder_mask_decoder' };
  case 'ImageTextToText': return { embed_tokens: 'embed_tokens', decoder_model_merged: 'decoder_model_merged', ...textOnly ? {} : { vision_encoder: 'vision_encoder' }, ...encoderDecoder ? { model: 'encoder_model' } : {} };
  case 'AudioTextToText':
  case 'VoxtralRealtime': return { embed_tokens: 'embed_tokens', decoder_model_merged: 'decoder_model_merged', ...textOnly ? {} : { audio_encoder: 'audio_encoder' } };
  case 'ImageAudioTextToText': return { embed_tokens: 'embed_tokens', decoder_model_merged: 'decoder_model_merged', ...textOnly ? {} : { audio_encoder: 'audio_encoder', vision_encoder: 'vision_encoder' } };
  case 'Musicgen': return { model: 'text_encoder', decoder_model_merged: 'decoder_model_merged', encodec_decode: 'encodec_decode' };
  case 'Phi3V': return { prepare_inputs_embeds: 'prepare_inputs_embeds', model: 'model', vision_encoder: 'vision_encoder' };
  case 'MultiModality': return { prepare_inputs_embeds: 'prepare_inputs_embeds', model: 'language_model', lm_head: 'lm_head', gen_head: 'gen_head', gen_img_embeds: 'gen_img_embeds', image_decode: 'image_decode' };
  case 'AutoEncoder': return { encoder_model: 'encoder_model', decoder_model: 'decoder_model' };
  case 'Supertonic': return { text_encoder: 'text_encoder', latent_denoiser: 'latent_denoiser', voice_decoder: 'voice_decoder' };
  case 'Chatterbox': return { embed_tokens: 'embed_tokens', speech_encoder: 'speech_encoder', model: 'language_model', conditional_decoder: 'conditional_decoder' };
  default: {
    const unexpected: never = family;
    throw new Error(`Unsupported session family: ${unexpected}`);
  }
  }
}

export function selectProductionModelResources({ autoClass, config: inputConfig, candidate: inputCandidate }: {
  autoClass: TransformersJsProductionInvestigationAutoClass,
  config: unknown,
  candidate: TransformersJsProductionInvestigationCandidate,
}): { className: string; sessions: ProductionResourceSession[]; paths: string[] } {
  if (runtime.env.version !== contract.version) throw new Error('Transformers.js resource selector requires a reviewed runtime version');
  const candidate = candidateSchema.parse(inputCandidate);
  const config = configSchema.parse(inputConfig);
  const mapping: Record<string, string> = (() => {
    switch (autoClass) {
    case 'AutoModelForCausalLM': return contract.causalClasses;
    case 'AutoModelForImageTextToText': return contract.imageTextClasses;
    default: {
      const unexpected: never = autoClass;
      throw new Error(`Unsupported Production AutoClass: ${unexpected}`);
    }
    }
  })();
  // Match this pinned AutoClass implementation, including its exact-class-name
  // fallback expression. Do not invent an additional supported model alias.
  const className = (Object.hasOwn(mapping, config.model_type) ? mapping[config.model_type] : undefined)
    ?? Object.values(mapping).find(name => name[0] === config.model_type);
  if (!className) throw new Error(`Unsupported model type: ${config.model_type}`);
  const selectedClass: unknown = Reflect.get(runtime, className);
  if (typeof selectedClass !== 'function' || Reflect.get(selectedClass, 'from_pretrained') !== runtime.PreTrainedModel.from_pretrained) {
    throw new Error(`Unsupported non-generic or unavailable runtime loader: ${className}`);
  }
  const nativeFamilies: Record<string, string> = contract.classFamilies;
  let selectedFamily = familySchema.parse(nativeFamilies[className]);
  let textOnly = false;
  const nativeArchitecture = config.architectures?.[0];
  if (nativeArchitecture && nativeArchitecture !== className && className.endsWith('ForCausalLM') && nativeArchitecture.endsWith('ForConditionalGeneration')) {
    const nativeFamily = Object.hasOwn(nativeFamilies, nativeArchitecture) ? nativeFamilies[nativeArchitecture] : undefined;
    if (nativeFamily !== undefined) {
      selectedFamily = familySchema.parse(nativeFamily);
      textOnly = true;
    }
  }
  const custom = config['transformers.js_config'] ?? {};
  const deviceConfigs = z.record(z.string(), z.unknown()).nullish().parse(custom.device_config);
  const selectedDeviceConfigResult = z.record(z.string(), z.unknown()).nullish().safeParse(deviceConfigs?.[candidate.device]);
  if (!selectedDeviceConfigResult.success) throw new ProductionResourceCandidateError({ candidate, cause: selectedDeviceConfigResult.error });
  const selectedDeviceConfig = selectedDeviceConfigResult.data;
  const effective = { ...custom, ...selectedDeviceConfig };
  const external = effective.use_external_data_format;
  const sessions = Object.entries(sessionsForFamily({ family: selectedFamily, textOnly, encoderDecoder: config.is_encoder_decoder === true })).map(([key, baseName]): ProductionResourceSession => {
    const fullName = `${baseName}_${candidate.dtype}.onnx`;
    const selectedDeclaration = typeof external === 'object' && external !== null
      ? Object.hasOwn(external, fullName) ? Reflect.get(external, fullName) : Object.hasOwn(external, baseName) ? Reflect.get(external, baseName) : undefined
      : external;
    // Validate only the declaration the real loader selects. An unrelated
    // dtype or device must not reject an otherwise usable explicit candidate.
    const declarationResult = externalCountSchema.nullish().safeParse(selectedDeclaration);
    if (!declarationResult.success) throw new ProductionResourceCandidateError({ candidate, cause: declarationResult.error });
    const declaration = declarationResult.data;
    const count = declaration === true ? 1 : declaration === false || declaration == null ? 0 : declaration;
    const externalData = Array.from({ length: count }, (_, index) => {
      const bindingPath = `${fullName}_data${index === 0 ? '' : `_${index}`}`;
      return { path: `onnx/${bindingPath}`, bindingPath };
    });
    return { key, baseName, corePath: `onnx/${fullName}`, externalData, device: candidate.device, dtype: candidate.dtype };
  });
  return { className, sessions, paths: [...new Set(sessions.flatMap(session => [session.corePath, ...session.externalData.map(item => item.path)]))].sort() };
}

export const TEST_ONLY = {
};
