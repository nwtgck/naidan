import { ref, shallowRef } from 'vue';
import type { ModelLaunchProblem } from './target';

export type ModelLaunchEntryState =
  | { status: 'idle' }
  | { status: 'checking', input: string, phase: 'metadata' | 'opening-chat' }
  | { status: 'failed', input: string, problem: ModelLaunchProblem | 'failed' };
export const modelLaunchEntryState = shallowRef<ModelLaunchEntryState>({ status: 'idle' });
export const modelLaunchRetry = ref(0);
export const MODEL_LAUNCH_QUERY = 'llama-cpp-browser-model';
export function retryModelLaunch(): void {
  modelLaunchRetry.value++;
}
export const TEST_ONLY = {
  reset: () => {
    modelLaunchEntryState.value = { status: 'idle' }; modelLaunchRetry.value = 0;
  },
};
