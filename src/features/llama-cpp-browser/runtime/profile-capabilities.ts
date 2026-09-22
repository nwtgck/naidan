import { z } from 'zod';
import { profileSchema, type ErrorCode, type LlamaCppProfile, type RuntimeOptions } from '@/features/llama-cpp-browser/types';

export const profileUnavailableReasonSchema = z.enum(['wasm', 'memory64', 'jspi', 'webgpu', 'shader-f16', 'brotli', 'storage', 'worker']);
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
  case 'cpu-wasm32': case 'cpu-wasm64': case 'webgpu-wasm64-jspi': case 'webgpu-wasm32-jspi': case 'webgpu-wasm32-asyncify': return preference;
  default: { const exhaustive: never = preference; throw new Error(`Unhandled profile: ${exhaustive}`); }
  }
}
export const TEST_ONLY = {
};
