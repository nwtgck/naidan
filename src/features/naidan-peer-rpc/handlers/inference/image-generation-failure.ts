import { z } from 'zod';
import { NaidanRpcError, NaidanRpcPublicError } from '@/features/naidan-rpc';
import { imageErrorContext } from '@/features/stable-diffusion-cpp-browser/diagnostics';

/** Only these public fields leave the provider; native text stays local. */
const imageGenerationFailureSchema = z.strictObject({
  kind: z.literal('image-generation'),
  stage: z.enum(['admission', 'input', 'model-selection', 'worker', 'runtime-fetch', 'runtime-init', 'model-header', 'model-load',
    'generation', 'sampling', 'decoding', 'encoding', 'cleanup', 'output-validation', 'preview-delivery', 'image-delivery']),
  reason: z.enum(['engine-busy', 'invalid-input', 'model-selection-failed', 'runtime-unavailable', 'engine-failed',
    'invalid-output', 'generation-failed', 'preview-delivery-failed', 'image-delivery-failed']),
  errorType: z.enum(['wasm-trap', 'error', 'non-error', 'gpu']),
  profile: z.string().max(64).optional(),
  wasmFrames: z.string().max(512).optional(),
  nativeCall: z.enum(['new_sd_ctx', 'generate_image', 'native-boundary']).optional(),
});
export type ImageGenerationFailure = z.infer<typeof imageGenerationFailureSchema>;
const nativeFailureContextSchema = z.strictObject({
  errorType: z.enum(['wasm-trap', 'error', 'non-error']),
  wasmFrames: z.string().max(512).regex(/^(?:wasm-function\[\d{1,10}\]:(?:0x[0-9a-f]{1,16}|\d{1,16})(?: <- wasm-function\[\d{1,10}\]:(?:0x[0-9a-f]{1,16}|\d{1,16}))*)?$/i).optional(),
  nativeCall: imageGenerationFailureSchema.shape.nativeCall,
});
export type ImageGenerationNativeFailureContext = z.infer<typeof nativeFailureContextSchema>;

export function readImageGenerationNativeFailureContext({ fields }: { fields: Readonly<Record<string, unknown>> }): ImageGenerationNativeFailureContext | undefined {
  const parsed = nativeFailureContextSchema.safeParse({ errorType: fields.errorType, wasmFrames: fields.wasmFrames, nativeCall: fields.nativeCall });
  return parsed.success ? parsed.data : undefined;
}

export function createImageGenerationFailure({ error, stage, reason, profile, gpu, nativeContext }: {
  error: unknown; stage: ImageGenerationFailure['stage']; reason: ImageGenerationFailure['reason']; profile: string | undefined; gpu: boolean;
  nativeContext: ImageGenerationNativeFailureContext | undefined;
}): NaidanRpcPublicError {
  if (error instanceof NaidanRpcPublicError) return error;
  const context = imageErrorContext({ error });
  const frames = nativeContext?.wasmFrames || context.wasmFrames;
  const details = imageGenerationFailureSchema.parse({
    kind: 'image-generation',
    stage,
    reason,
    errorType: gpu ? 'gpu' : nativeContext?.errorType ?? context.errorType,
    ...(profile === undefined ? {} : { profile }),
    ...(frames ? { wasmFrames: frames } : {}),
    ...(nativeContext?.nativeCall === undefined ? {} : { nativeCall: nativeContext.nativeCall }),
  });
  const { kind, stage: publicStage, reason: publicReason, errorType, profile: publicProfile, wasmFrames, nativeCall, ...rest } = details;
  rest satisfies Record<PropertyKey, never>;
  return new NaidanRpcPublicError({
    code: error instanceof NaidanRpcError ? error.code : 'HANDLER_FAILED',
    details: {
      kind,
      stage: publicStage,
      reason: publicReason,
      errorType,
      ...(publicProfile === undefined ? {} : { profile: publicProfile }),
      ...(wasmFrames === undefined ? {} : { wasmFrames }),
      ...(nativeCall === undefined ? {} : { nativeCall }),
    },
  });
}

export const TEST_ONLY = {
};
