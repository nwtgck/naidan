import { storageService } from '@/00-storage/service';
import type { Chat, Endpoint } from '@/01-models/types';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import { ensureStrings } from '@/strings';
import { installedSelection } from '@/features/llama-cpp-browser/hugging-face/storage';

/** A manual endpoint/model override leaves the launch route without being undone. */
export function applicableModelLaunchTarget({ chat, endpoint, modelId }: {
  chat: Pick<Chat, 'id'> | undefined, endpoint: Endpoint | undefined, modelId: string | undefined,
}): ModelLaunchTarget | undefined {
  const launch = chat === undefined ? undefined : storageService.getModelLaunch({ chatId: chat.id });
  return launch?.phase === 'active' && endpoint?.type === 'llama_cpp_browser' && modelId === launch.target.modelId ? launch.target : undefined;
}

export async function isModelLaunchTargetReady({ target }: { target: ModelLaunchTarget }): Promise<boolean> {
  const model = await installedSelection({ selection: target.selection });
  return model?.id === target.modelId;
}

/** Recheck bytes at the generation boundary, not only the visual button. */
export async function assertModelLaunchReady({ chat, endpoint, modelId }: {
  chat: Pick<Chat, 'id'>, endpoint: Endpoint, modelId: string | undefined,
}): Promise<ModelLaunchTarget | undefined> {
  const target = applicableModelLaunchTarget({ chat, endpoint, modelId });
  if (target === undefined && storageService.getModelLaunch({ chatId: chat.id })?.phase !== 'reserved') return undefined;
  let ready = false;
  try {
    if (target !== undefined) {
      const meta = await storageService.loadChatMeta({ id: chat.id });
      const stored = storageService.getModelLaunch({ chatId: chat.id });
      const chatGroup = meta?.groupId == null ? undefined : await storageService.loadChatGroup({ id: meta.groupId });
      const settings = meta?.endpoint === undefined && chatGroup?.endpoint === undefined || meta?.modelId === undefined && chatGroup?.modelId === undefined ? await storageService.loadSettings() : undefined;
      const storedEndpoint = meta?.endpoint ?? chatGroup?.endpoint ?? settings?.endpoint;
      const storedModel = meta?.modelId ?? chatGroup?.modelId ?? settings?.defaultModelId;
      ready = stored?.phase === 'active' && JSON.stringify(stored.target) === JSON.stringify(target)
        && storedEndpoint?.type === 'llama_cpp_browser' && storedModel === target.modelId
        && await isModelLaunchTargetReady({ target });
    }
  } catch { /* Storage failure is not a fallback authorization. */ }
  if (!ready) {
    throw new Error(await ensureStrings.LlamaCppBrowserModelLaunch__model_not_ready());
  }
  return target;
}

export const TEST_ONLY = {
};
