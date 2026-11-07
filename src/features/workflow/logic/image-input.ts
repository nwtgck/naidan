import { z } from 'zod';
import type { WorkflowImageParameters, WorkflowStep } from '@/01-models/workflow';
import { parametersSchema, profileSchema, weightResidencySchema, imageInputsSchema, previewSettingsSchema } from '@/features/stable-diffusion-cpp-browser/types';
import { readText, materializeJson, type RuntimeValue } from './values';
import { workflowImageModelSchema } from './image-model-schema';

export const workflowImageParametersSchema = parametersSchema.omit({ prompt: true }).extend({
  profile: z.union([z.literal('auto'), profileSchema]),
  weightResidency: weightResidencySchema,
});
export const workflowImageRequestSchema = z.object({
  model: workflowImageModelSchema,
  prompt: parametersSchema.shape.prompt,
  parameters: workflowImageParametersSchema,
  imageInputs: imageInputsSchema.optional(),
  preview: previewSettingsSchema.optional(),
  gpuBudgetMiB: z.number().int().min(512).max(Math.floor(Number.MAX_SAFE_INTEGER / 1024 ** 2)).optional(),
});
export type WorkflowImageRequest = z.infer<typeof workflowImageRequestSchema>;
export const workflowImageParameterKeys = [
  'negativePrompt', 'width', 'height', 'steps', 'guidance', 'seed', 'sampler', 'scheduler',
  'distilledGuidance', 'vaeTiling', 'vaeTileSize', 'flashAttention', 'bf16WeightType', 'qwenVaePolicy',
  'conditioningCacheSize', 'modelArguments', 'profile', 'weightResidency',
] as const satisfies readonly (keyof WorkflowImageParameters)[];

export function workflowImageParameterType({ key }: { key: keyof WorkflowImageParameters }): 'text' | 'number' | 'boolean' {
  switch (key) {
  case 'negativePrompt': case 'seed': case 'sampler': case 'scheduler': case 'bf16WeightType': case 'qwenVaePolicy': case 'modelArguments': case 'profile': case 'weightResidency': return 'text';
  case 'width': case 'height': case 'steps': case 'guidance': case 'distilledGuidance': case 'vaeTileSize': case 'conditioningCacheSize': return 'number';
  case 'vaeTiling': case 'flashAttention': return 'boolean';
  default: {
    const exhaustive: never = key;
    throw new Error(String(exhaustive));
  }
  }
}

export function defaultWorkflowImageParameters(): WorkflowImageParameters {
  return {
    negativePrompt: { type: 'literal', value: '' },
    width: { type: 'literal', value: 256 },
    height: { type: 'literal', value: 256 },
    steps: { type: 'literal', value: 20 },
    guidance: { type: 'literal', value: 7 },
    seed: { type: 'literal', value: '42' },
    sampler: { type: 'literal', value: 'auto' },
    scheduler: { type: 'literal', value: 'auto' },
    distilledGuidance: { type: 'literal', value: 3.5 },
    vaeTiling: { type: 'literal', value: true },
    vaeTileSize: { type: 'literal', value: 32 },
    flashAttention: { type: 'literal', value: false },
    bf16WeightType: { type: 'literal', value: 'f32' },
    qwenVaePolicy: { type: 'literal', value: 'bounded' },
    conditioningCacheSize: { type: 'literal', value: 0 },
    modelArguments: { type: 'literal', value: '' },
    profile: { type: 'literal', value: 'auto' },
    weightResidency: { type: 'literal', value: 'auto' },
  };
}

export function workflowImageLiteralIssues({ step }: { step: Extract<WorkflowStep, { type: 'image_generation' }> }): { path: string, message: string }[] {
  const fields = [
    { path: 'model', value: step.model, schema: workflowImageModelSchema },
    { path: 'prompt', value: step.prompt, schema: workflowImageRequestSchema.shape.prompt },
    { path: 'gpuBudgetMiB', value: step.gpuBudgetMiB, schema: workflowImageRequestSchema.shape.gpuBudgetMiB },
    { path: 'imageInputs.strength', value: step.imageInputs?.strength, schema: imageInputsSchema.shape.strength },
    { path: 'preview', value: step.preview === undefined ? undefined : { type: 'literal' as const, value: { ...step.preview } }, schema: previewSettingsSchema },
    ...workflowImageParameterKeys.map(key => ({ path: `parameters.${key}`, value: step.parameters[key], schema: workflowImageParametersSchema.shape[key] })),
  ];
  return fields.flatMap(({ path, value, schema }) => {
    if (!value) {
      return [];
    }
    switch (value.type) {
    case 'literal': break;
    case 'arithmetic': case 'compare': case 'all': case 'any': case 'not': case 'model': case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state': case 'array': case 'object': case 'concat': case 'path': case 'get': case 'filename': case 'format_number': case 'equals': case 'not_empty': case 'conversation': case 'range': case 'json_compose': return [];
    default: {
      const exhaustive: never = value;
      throw new Error(String(exhaustive));
    }
    }
    const result = schema.safeParse(value.value);
    return result.success ? [] : [{ path, message: result.error.issues.map(issue => issue.message).join('; ') }];
  });
}

export async function resolveWorkflowImageRequest({ values, signal }: { values: Record<string, RuntimeValue>, signal: AbortSignal }): Promise<WorkflowImageRequest> {
  if (!values.model || !values.prompt) {
    throw new Error('Missing image model or prompt.');
  }
  const parameters: Record<string, unknown> = {};
  for (const key of workflowImageParameterKeys) {
    signal.throwIfAborted();
    const value = values[key];
    if (!value) {
      throw new Error(`Missing image parameter: ${key}`);
    }
    const type = workflowImageParameterType({ key });
    switch (type) {
    case 'text': parameters[key] = await readText({ value, maxBytes: 32768, signal });
      break;
    case 'number': case 'boolean':
      if (value.type !== 'json' || typeof value.value !== type) {
        throw new Error(`Image parameter requires ${type}: ${key}`);
      }
      parameters[key] = value.value;
      break;
    default: {
      const exhaustive: never = type;
      throw new Error(String(exhaustive));
    }
    }
  }
  let gpuBudgetMiB: number | undefined;
  if (values.gpuBudgetMiB !== undefined) {
    if (values.gpuBudgetMiB.type !== 'json' || typeof values.gpuBudgetMiB.value !== 'number') {
      throw new Error('Image memory budget requires a number.');
    }
    gpuBudgetMiB = values.gpuBudgetMiB.value;
  }
  return workflowImageRequestSchema.parse({
    model: await materializeJson({ value: values.model, signal }),
    prompt: await readText({ value: values.prompt, maxBytes: 32768, signal }),
    parameters,
    gpuBudgetMiB,
  });
}

export const TEST_ONLY = {
};
