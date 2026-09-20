import { inject, provide, ref, shallowRef, type InjectionKey } from 'vue';
import type { RepositoryCatalog } from './catalog';

function createSession() {
  // Keep only preparation state across tabs; operations and local-file checks belong to each mount.
  return {
    input: ref(''),
    checkedInput: ref(''),
    catalog: shallowRef<RepositoryCatalog>(),
    requestedVariantUnresolved: ref(false),
    quantization: ref(''),
    candidate: ref(''),
    projector: ref(''),
    multimodal: ref<'off' | 'on'>('off'),
  };
}
const sessionKey: InjectionKey<ReturnType<typeof createSession>> = Symbol('llama-cpp-browser-hugging-face-session');
export function provideHuggingFaceSession(): void {
  provide(sessionKey, createSession());
}
export function useHuggingFaceSession(): ReturnType<typeof createSession> {
  return inject(sessionKey, undefined) ?? createSession();
}
export const TEST_ONLY = {
};
