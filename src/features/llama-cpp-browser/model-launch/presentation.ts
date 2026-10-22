import type { ModelLaunchChatUi } from '@/features/llama-cpp-browser/composables/useModelLaunchChat';
import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/repository-input';

/** A local display hint only: never authorizes a download or guesses model files. */
export function modelLaunchPresentation({ input }: { input: unknown }): ReturnType<typeof parseRepository> | undefined {
  if (typeof input !== 'string' || input.length === 0 || input.length > 4096) {
    return undefined;
  }
  try {
    return parseRepository({ input });
  } catch {
    return undefined;
  }
}

/** The progress card and composer hint must agree about the current stage. */
export function modelLaunchPreparationStage({ state }: { state: ModelLaunchChatUi }): 'preview' | 'download' | 'loading' | 'ready' | 'failed' {
  if (state.restoration.value === 'failed' || state.needsRecovery.value || state.error.value || state.warmup.value === 'failed' || state.runtimeUnavailable.value) {
    return 'failed';
  }
  const job = state.job.value;
  if (state.observedDownload.value !== undefined && job === undefined) {
    return 'download';
  }
  if (job !== undefined && job.status !== 'complete' && job.status !== 'cancelled' && state.readiness.value !== 'ready') {
    return 'download';
  }
  if (state.readiness.value === 'ready' && !state.selectionChanged.value) {
    return state.warmup.value === 'ready' || state.isActive.value && state.maySend.value ? 'ready' : 'loading';
  }
  if (state.readiness.value === 'checking' || state.readiness.value === 'failed'
    || state.verification.value === 'checking' && state.downloadVerificationPending.value
    || state.restoration.value === 'checking' || state.operation.value !== 'idle') {
    return 'loading';
  }
  return 'preview';
}

export const TEST_ONLY = {
};
