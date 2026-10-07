import { watch } from 'vue';
import { useRouter } from 'vue-router';
import { useSettings } from '@/composables/useSettings';
import { useAppPresentation, isAppInteractionEnabled } from '@/composables/useAppPresentation';
import { storageService } from '@/00-storage/service';
import { loadData } from '@/composables/chat/global/chat-core-singletons';
import { idToRaw } from '@/01-models/ids';
import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { modelLaunchChatGroupName, ModelLaunchTargetError, rememberLaunchCatalog, resolveModelLaunchTarget } from '@/features/llama-cpp-browser/model-launch/target';
import { reserveModelLaunchHistory, modelLaunchHistoryKey, modelLaunchViewHistoryKey, modelLaunchViewState } from '@/features/llama-cpp-browser/model-launch/history';
import { MODEL_LAUNCH_QUERY, modelLaunchEntryState, modelLaunchRetry } from '@/features/llama-cpp-browser/model-launch/entry-state';

export function useModelLaunchCoordinator(): void {
  const router = useRouter();
  const { initialized, settings } = useSettings();
  const { appInteraction } = useAppPresentation();
  let active: { input: string, reservation: ReturnType<typeof reserveModelLaunchHistory> } | undefined;
  watch([() => router.currentRoute.value.fullPath, initialized, appInteraction, modelLaunchRetry, () => settings.value.storageType], async (_values, _previous, onCleanup) => {
    const source = router.currentRoute.value;
    if (source.path !== '/' || source.query[MODEL_LAUNCH_QUERY] === undefined) {
      active = undefined;
      modelLaunchEntryState.value = { status: 'idle' };
      return;
    }
    if (!initialized.value || !isAppInteractionEnabled({ interaction: appInteraction.value })) return;
    const isStorageCurrent = storageService.captureModelLaunchStorage();
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    const isCurrent = (): boolean => !controller.signal.aborted && isStorageCurrent() && router.currentRoute.value.fullPath === source.fullPath;
    const rawInput = source.query[MODEL_LAUNCH_QUERY];
    const input = typeof rawInput === 'string' ? rawInput.trim() : '';
    if (active?.input !== input) active = undefined;
    modelLaunchEntryState.value = { status: 'checking', input, phase: 'metadata' };
    try {
      // Reject duplicates/empty values instead of silently choosing a request.
      if (typeof rawInput !== 'string' || input.length === 0 || input.length > 4096) throw new ModelLaunchTargetError({ problem: 'invalid-input' });
      try {
        parseRepository({ input });
      } catch {
        throw new ModelLaunchTargetError({ problem: 'invalid-input' });
      }
      const reservation = reserveModelLaunchHistory({ history: router.options.history, location: `${MODEL_LAUNCH_QUERY}=${input}`, fallback: active?.reservation });
      active = { input, reservation };
      const previous = storageService.getModelLaunch({ chatId: reservation.chatId });
      if (!isCurrent()) return;
      let resolved;
      if (previous !== undefined) {
        resolved = { target: previous.target, requestedVariant: previous.requestedVariant };
      } else {
        const catalog = await getMetadataSession().inspect({ input, signal: controller.signal, freshness: 'reuse' });
        if (!isCurrent()) return;
        resolved = resolveModelLaunchTarget({ input, catalog });
        rememberLaunchCatalog({ catalog });
      }
      if (!isCurrent()) return;
      modelLaunchEntryState.value = { status: 'checking', input, phase: 'opening-chat' };
      const chat = await storageService.prepareModelLaunchChat({
        signal: controller.signal,
        request: {
          ...reservation,
          input,
          ...resolved,
          chatGroupName: modelLaunchChatGroupName({ target: resolved.target }),
          titleGeneration: settings.value.titleGeneration,
          mode: 'create-or-resume',
          expectedTarget: undefined,
        },
      });
      if (!isCurrent()) return;
      await loadData();
      if (!isCurrent()) return;
      const query = { ...source.query };
      delete query[MODEL_LAUNCH_QUERY];
      // A model link never delegates submission or chat settings to the legacy
      // auto-send route. Keep unrelated navigation/settings query parameters.
      for (const key of ['q', 'chat-group', 'model', 'system-prompt', 'sp']) delete query[key];
      const path = `/chat/${idToRaw({ id: chat.id })}`;
      const failure = await router.replace({ path, query, hash: source.hash, state: { [modelLaunchHistoryKey]: false, [modelLaunchViewHistoryKey]: modelLaunchViewState({ chatId: chat.id, input, modelId: resolved.target.modelId, revision: resolved.target.selection.revision }) } });
      if (failure || router.currentRoute.value.path !== path) {
        if (isCurrent()) modelLaunchEntryState.value = { status: 'failed', input, problem: 'failed' };
      }
    } catch (error) {
      if (isCurrent()) modelLaunchEntryState.value = { status: 'failed', input, problem: error instanceof ModelLaunchTargetError ? error.problem : 'failed' };
    }
  }, { immediate: true });
}
export const TEST_ONLY = {
};
