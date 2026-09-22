import { z } from 'zod';
import type { HostedTransformersRuntimeAssetUrls } from '@/features/transformers-js/runtime/configure-hosted-runtime';

export const runtimeControlBindingSchema = z.object({
  format: z.literal('runtime-control-binding-v1'),
  executionProvider: z.enum(['wasm', 'webgpu']),
  constructorModule: z.literal('onnxruntime-web/webgpu'),
  environmentMatchesConfigured: z.boolean(),
  mjs: z.object({
    matchesSelected: z.boolean(),
    byteConnection: z.literal('configured-url-not-verified-import-bytes'),
  }).strict(),
  wasm: z.object({
    matchesSelected: z.boolean(),
    supplySource: z.literal('preflight-verified-buffer'),
    suppliedByteLength: z.number().int().min(8).max(64 * 1024 * 1024),
    suppliedSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    suppliedMagicHex: z.string().regex(/^[0-9a-f]{16}$/u),
    compilerConsumption: z.literal('not-observed'),
  }).strict(),
}).strict();

export type RuntimeControlBinding = z.infer<typeof runtimeControlBindingSchema>;
const runtimeControlBindingsSchema = z.object({
  wasm: runtimeControlBindingSchema.extend({ executionProvider: z.literal('wasm') }).optional(),
  webgpu: runtimeControlBindingSchema.extend({ executionProvider: z.literal('webgpu') }).optional(),
}).strict();
const bindingContainerSchema = z.object({ controlRuntimeBindings: runtimeControlBindingsSchema.optional() });
const bindingEnvelopeSchema = z.object({
  runtimeAssets: bindingContainerSchema.optional(),
  runtimeAssetsPartial: bindingContainerSchema.optional(),
});

/** Validate only the new bounded receipt, not unrelated legacy Run fields. */
export function validateRuntimeControlBindings({ run }: { run: unknown }): void {
  bindingEnvelopeSchema.parse(run);
}
export type VerifiedRuntimeControlBytes = { bytes: Uint8Array, sha256: string };
export type RuntimeControlInput = {
  verifiedWasm: VerifiedRuntimeControlBytes | undefined,
  observeBinding: ({ observation }: { observation: RuntimeControlBinding }) => unknown,
};

interface ControlWasmEnvironment {
  wasmPaths?: unknown,
  wasmBinary?: ArrayBufferLike | Uint8Array,
}

/** Supply the verified bytes to the real control environment. The receipt says
 * "supplied", not "compiled": upstream may retain an initialized WASM instance. */
export async function withVerifiedRuntimeControl<T>({
  executionProvider, assets, configuredEnvironment, controlEnvironment,
  verifiedWasm, observeBinding, run,
}: {
  executionProvider: 'wasm' | 'webgpu',
  assets: HostedTransformersRuntimeAssetUrls,
  configuredEnvironment: unknown,
  controlEnvironment: ControlWasmEnvironment,
  verifiedWasm: VerifiedRuntimeControlBytes | undefined,
  observeBinding: ({ observation }: { observation: RuntimeControlBinding }) => unknown,
  run: () => Promise<T>,
}): Promise<T> {
  if (verifiedWasm === undefined) throw new Error('Verified runtime WASM bytes are unavailable for this control');
  const previousBinary = controlEnvironment.wasmBinary;
  controlEnvironment.wasmBinary = verifiedWasm.bytes;
  try {
    try {
      const paths = controlEnvironment.wasmPaths;
      const mjs = typeof paths === 'object' && paths !== null ? Reflect.get(paths, 'mjs') : undefined;
      const wasm = typeof paths === 'object' && paths !== null ? Reflect.get(paths, 'wasm') : undefined;
      // The existing preflight already records selected assets. Retain only
      // equality here: arbitrary configured URLs may contain credentials.
      const observation = runtimeControlBindingSchema.parse({
        format: 'runtime-control-binding-v1', executionProvider,
        constructorModule: 'onnxruntime-web/webgpu',
        environmentMatchesConfigured: configuredEnvironment === controlEnvironment,
        mjs: {
          matchesSelected: mjs === assets.mjsUrl,
          byteConnection: 'configured-url-not-verified-import-bytes',
        },
        wasm: {
          matchesSelected: wasm === assets.wasmUrl,
          supplySource: 'preflight-verified-buffer',
          suppliedByteLength: verifiedWasm.bytes.byteLength,
          suppliedSha256: verifiedWasm.sha256,
          suppliedMagicHex: Array.from(verifiedWasm.bytes.subarray(0, 8), byte => byte.toString(16).padStart(2, '0')).join(''),
          compilerConsumption: 'not-observed',
        },
      });
      // Neither a pending observer nor a later rejection owns native control
      // completion. Consume advisory Promise failures without awaiting them.
      void Promise.resolve(observeBinding({ observation })).catch(() => undefined);
    } catch {
      // Advisory evidence must not replace the native control's result.
    }
    return await run();
  } finally {
    controlEnvironment.wasmBinary = previousBinary;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
