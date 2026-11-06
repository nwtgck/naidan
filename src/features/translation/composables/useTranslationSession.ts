import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import { errorCode, type ErrorCode } from '@/features/llama-cpp-browser/types';
import { translationProfile } from '@/features/translation/profiles';
import { TranslationInputError, type InspectTranslationModel, type TranslationDraft, type TranslationIssue, type TranslationPhase, type TranslationProgress } from '@/features/translation/types';

export function useTranslationSession({ service, inspectModel }: {
  service: Pick<LlamaCppBrowserService, 'runGenerationOperation'>, inspectModel: InspectTranslationModel,
}) {
  const phase = ref<TranslationPhase>('idle');
  const output = ref('');
  const previousOutput = ref('');
  const displayRevision = ref(0);
  let completedOutput = '';
  const progress = shallowRef<TranslationProgress>();
  const issue = ref<TranslationIssue>();
  const failure = ref<ErrorCode>();
  const active = shallowRef<AbortController>();
  const busy = computed(() => active.value !== undefined);
  let disposed = false;
  let revision = 0;

  async function translate({ draft }: { draft: TranslationDraft }): Promise<void> {
    if (disposed || busy.value) {
      return;
    }
    // Snapshot every mutable input before the first asynchronous boundary.
    const accepted: TranslationDraft = { ...draft, glossary: draft.glossary.map(term => ({ ...term })) };
    const controller = new AbortController();
    const requestRevision = ++revision;
    const current = () => !disposed && requestRevision === revision && active.value === controller;
    active.value = controller;
    phase.value = 'checking';
    previousOutput.value = completedOutput;
    displayRevision.value++;
    output.value = '';
    issue.value = undefined;
    failure.value = undefined;
    progress.value = undefined;
    try {
      const detection = await inspectModel({ modelId: accepted.modelId, signal: controller.signal });
      controller.signal.throwIfAborted();
      switch (detection.status) {
      case 'supported': break;
      case 'unsupported': throw new TranslationInputError({ issue: 'unsupported-model' });
      default: {
        const exhaustive: never = detection;
        throw new Error(String(exhaustive));
      }
      }
      const input = translationProfile({ id: detection.profileId }).buildRequest({ draft: accepted });
      if (!current()) {
        return;
      }
      // A new request does not imply that model weights are loading.
      phase.value = 'prefill';
      await service.runGenerationOperation({
        signal: controller.signal,
        onProgress: ({ progress: next }) => {
          if (!current() || controller.signal.aborted) {
            return;
          }
          progress.value = next;
          switch (next.phase) {
          case 'loading': phase.value = 'preparing';
            break;
          case 'importing': case 'initializing': break;
          case 'prefill': phase.value = 'prefill';
            break;
          case 'generating': phase.value = 'generating';
            break;
          case 'decoding-audio': break;
          default: {
            const exhaustive: never = next.phase;
            throw new Error(String(exhaustive));
          }
          }
        },
        operation: async ({ scope }) => {
          const result = await scope.generate({
            input,
            signal: controller.signal,
            onEvent: ({ event }) => {
              if (!current() || controller.signal.aborted) {
                return;
              }
              switch (event.type) {
              case 'text':
                phase.value = 'generating';
                output.value += event.text;
                break;
              case 'generation_metrics': case 'reasoning': break;
              case 'tool_call_start': case 'tool_call_draft': case 'tool_call':
                throw new TranslationInputError({ issue: 'unexpected-output' });
              default: {
                const exhaustive: never = event;
                throw new Error(String(exhaustive));
              }
              }
            },
          });
          controller.signal.throwIfAborted();
          if (!current()) {
            return;
          }
          if (result.toolCalls.length !== 0 || !result.content.trim()) {
            throw new TranslationInputError({ issue: 'unexpected-output' });
          }
          output.value = result.content;
          switch (result.finishReason) {
          case 'length': phase.value = 'truncated';
            break;
          case 'stop': case 'stop_sequence': phase.value = 'complete';
            break;
          default: {
            const exhaustive: never = result.finishReason;
            throw new Error(String(exhaustive));
          }
          }
        },
      });
      controller.signal.throwIfAborted();
      if (current()) {
        completedOutput = output.value;
      }
    } catch (error) {
      if (!current()) {
        return;
      }
      if (controller.signal.aborted || errorCode({ error }) === 'aborted') {
        phase.value = 'stopped';
      } else {
        phase.value = 'error';
        // A failed replacement must not erase the last successful translation.
        output.value = '';
        if (error instanceof TranslationInputError) {
          issue.value = error.issue;
        } else {
          failure.value = errorCode({ error });
        }
      }
    } finally {
      // Cancellation invalidates output immediately, but must not release the
      // generation lane until the old operation actually settles.
      if (active.value === controller) {
        active.value = undefined;
        progress.value = undefined;
        if (requestRevision !== revision) {
          phase.value = 'idle';
        }
      }
    }
  }

  function stop(): void {
    if (active.value) {
      phase.value = 'stopping';
      active.value.abort();
    }
  }

  function invalidate(): void {
    revision++;
    active.value?.abort();
    output.value = '';
    previousOutput.value = completedOutput;
    displayRevision.value++;
    progress.value = undefined;
    issue.value = undefined;
    failure.value = undefined;
    phase.value = active.value ? 'stopping' : 'idle';
  }

  function reset(): void {
    completedOutput = '';
    invalidate();
  }

  onScopeDispose(() => {
    disposed = true;
    reset();
  });
  return {
    phase,
    output,
    previousOutput,
    displayRevision,
    progress,
    issue,
    failure,
    busy,
    translate,
    stop,
    invalidate,
    reset,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
