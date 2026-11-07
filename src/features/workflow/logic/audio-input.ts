import type { WorkflowAudioParameters, WorkflowStep } from '@/01-models/workflow';
import { audioGenerationInputSchema, defaultAudioParameters, MAX_REFERENCE_BYTES, type AudioGenerationInput } from '@/features/audio-generation/types';
import { readText, type RuntimeValue } from './values';

/** Use the existing engine contract; workflow documents cannot supply debug or runtime options. */
export const workflowAudioRequestSchema = audioGenerationInputSchema.omit({ reference: true, options: true, debug: true });
export type WorkflowAudioRequest = Omit<AudioGenerationInput, 'reference' | 'options' | 'debug'>;
export const workflowAudioParameterKeys = ['language', 'audioBackend', 'contextTokens', 'maxFrames', 'temperature', 'topK', 'topP', 'seed'] as const satisfies readonly (keyof WorkflowAudioParameters)[];

export function defaultWorkflowAudioParameters(): WorkflowAudioParameters {
  const { language, audioBackend, contextTokens, maxFrames, temperature, topK, topP, seed, ...unhandled } = defaultAudioParameters();
  unhandled satisfies Record<PropertyKey, never>;
  return {
    language: { type: 'literal', value: language },
    audioBackend: { type: 'literal', value: audioBackend },
    contextTokens: { type: 'literal', value: contextTokens },
    maxFrames: { type: 'literal', value: maxFrames },
    temperature: { type: 'literal', value: temperature },
    topK: { type: 'literal', value: topK },
    topP: { type: 'literal', value: topP },
    seed: { type: 'literal', value: seed },
  };
}

/** Validate known literals before a run. Dynamic values use the same schema at the effect boundary. */
export function workflowAudioLiteralIssues({ step }: { step: Extract<WorkflowStep, { type: 'audio_generation' }> }): { path: string, message: string }[] {
  const issues: { path: string, message: string }[] = [];
  for (const key of ['modelId', 'text', ...workflowAudioParameterKeys] as const) {
    const value = key === 'modelId' || key === 'text' ? step[key] : step.parameters[key];
    switch (value.type) {
    case 'literal': break;
    case 'arithmetic': case 'compare': case 'all': case 'any': case 'not': case 'model': case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state': case 'array': case 'object': case 'concat': case 'path': case 'get': case 'filename': case 'format_number': case 'equals': case 'not_empty': case 'conversation': case 'range': case 'json_compose': continue;
    default: {
      const exhaustive: never = value;
      throw new Error(String(exhaustive));
    }
    }
    const result = workflowAudioRequestSchema.shape[key].safeParse(value.value);
    if (!result.success) {
      issues.push({ path: key === 'modelId' || key === 'text' ? key : `parameters.${key}`, message: result.error.issues.map(issue => issue.message).join('; ') });
    }
  }
  return issues;
}

export async function resolveWorkflowAudioRequest({ values, signal }: { values: Record<string, RuntimeValue>, signal: AbortSignal }): Promise<WorkflowAudioRequest> {
  const resolved: Record<string, unknown> = {};
  for (const key of ['modelId', 'text', ...workflowAudioParameterKeys] as const) {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`Missing audio input: ${key}`);
    }
    signal.throwIfAborted();
    switch (key) {
    case 'text': resolved[key] = await readText({ value, maxBytes: 32768, signal });
      break;
    case 'modelId': case 'language': case 'audioBackend': resolved[key] = await readText({ value, maxBytes: 8192, signal });
      break;
    case 'contextTokens': case 'maxFrames': case 'temperature': case 'topK': case 'topP': case 'seed':
      if (value.type !== 'json' || typeof value.value !== 'number') {
        throw new Error(`Audio parameter requires a number: ${key}`);
      }
      resolved[key] = value.value;
      break;
    default: {
      const exhaustive: never = key;
      throw new Error(String(exhaustive));
    }
    }
  }
  const reference = values.reference;
  if (reference !== undefined && (reference.type !== 'binary' || reference.output.byteLength <= 0 || reference.output.byteLength > MAX_REFERENCE_BYTES)) {
    throw new Error('Audio reference must be a nonempty binary file no larger than 16 MiB.');
  }
  return workflowAudioRequestSchema.parse(resolved);
}

export const TEST_ONLY = {
};
