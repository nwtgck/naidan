import { readonly, shallowRef } from 'vue';
import type { RuntimeOptions } from '@/features/llama-cpp-browser/types';
import { chatProfileSchema, type ChatProfile } from '@/features/llama-cpp-browser/chat-profiles';
const requested = shallowRef<readonly ChatProfile[]>([]);
export const requestedOfflineProfiles = readonly(requested);

export function recordOfflineProfile({ profile }: { profile: RuntimeOptions['profile'] }): void {
  const known = chatProfileSchema.safeParse(profile);
  if (known.success && !requested.value.includes(known.data)) {
    // Queued operations capture options at admission and may still use a previous preference.
    requested.value = [...requested.value, known.data];
  }
}

export const TEST_ONLY = {
};
