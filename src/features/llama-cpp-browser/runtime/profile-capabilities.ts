import { z } from 'zod';
import { profileSchema, type ErrorCode, type LlamaCppProfile, type RuntimeOptions } from '@/features/llama-cpp-browser/types';

export const profileUnavailableReasonSchema = z.enum(['wasm', 'memory64', 'jspi', 'webgpu', 'shader-f16', 'brotli', 'storage', 'worker', 'timestamp-query', 'profiling-artifact', 'standalone']);
export type ProfileUnavailableReason = z.infer<typeof profileUnavailableReasonSchema>;
const availabilitySchema = z.discriminatedUnion('status', [
  z.object({ profile: profileSchema, status: z.literal('available') }).strict(),
  z.object({ profile: profileSchema, status: z.literal('unavailable'), reason: profileUnavailableReasonSchema }).strict(),
]);
export const profileCapabilitiesSchema = z.object({
  recommended: profileSchema.optional(),
  profiles: z.array(availabilitySchema),
}).strict().superRefine((value, context) => {
  if (new Set(value.profiles.map(entry => entry.profile)).size !== value.profiles.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate runtime profile' });
  }
  switch (value.recommended) {
  case 'webgpu-wasm64-jspi-gpu-profile':
    context.addIssue({ code: 'custom', message: 'Diagnostic profiles cannot be recommended for chat' });
    break;
  case undefined: case 'cpu-wasm32': case 'webgpu-wasm64-jspi': case 'webgpu-wasm32-jspi': case 'webgpu-wasm32-asyncify': break;
  default: {
    const exhaustive: never = value.recommended;
    throw new Error(String(exhaustive));
  }
  }
  if (value.recommended !== undefined && !value.profiles.some(entry => entry.profile === value.recommended && entry.status === 'available')) {
    context.addIssue({ code: 'custom', message: 'Unavailable recommended runtime profile' });
  }
});
export type ProfileCapabilities = z.infer<typeof profileCapabilitiesSchema>;
export type ProfileState = { status: 'idle' } | { status: 'checking' }
  | { status: 'ready', capabilities: ProfileCapabilities } | { status: 'error', code: ErrorCode };

export function resolveProfilePreference({ preference, capabilities }: { preference: RuntimeOptions['profile'], capabilities: ProfileCapabilities | undefined }): LlamaCppProfile | undefined {
  switch (preference) {
  case 'auto': return capabilities?.recommended;
  case 'cpu-wasm32': case 'webgpu-wasm64-jspi-gpu-profile': case 'webgpu-wasm64-jspi': case 'webgpu-wasm32-jspi': case 'webgpu-wasm32-asyncify': return preference;
  default: {
    const exhaustive: never = preference;
    throw new Error(`Unhandled profile: ${exhaustive}`);
  }
  }
}

// Names of browser/build capabilities, shared by settings and investigation UI.
export const profileFeatures = {
  wasm: 'WebAssembly',
  memory64: 'WebAssembly memory64',
  jspi: 'WebAssembly JSPI',
  webgpu: 'WebGPU',
  'shader-f16': 'WebGPU shader-f16',
  brotli: 'Brotli',
  storage: 'OPFS',
  worker: 'Worker',
  'timestamp-query': 'WebGPU timestamp-query',
  'profiling-artifact': 'GPU profiling runtime',
  standalone: 'Hosted mode',
} satisfies Record<ProfileUnavailableReason, string>;

export const TEST_ONLY = {
};
