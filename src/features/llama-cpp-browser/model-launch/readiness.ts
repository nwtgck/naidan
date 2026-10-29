import { storageService } from '@/00-storage/service';
import type { Chat, Endpoint } from '@/01-models/types';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import type { DownloadDestination } from '@/01-models/download';
import { ensureStrings } from '@/strings';
import { installedSelection } from '@/features/llama-cpp-browser/hugging-face/storage';
import { assertLocalModelLaunchReady } from '@/features/llama-cpp-browser/composables/local-model-launch-session';
import { isModelLaunchPrepared } from './preparation';

/** A manual endpoint/model override leaves the launch route without being undone. */
export function applicableModelLaunchTarget({ chat, endpoint, modelId }: {
  chat: Pick<Chat, 'id'> | undefined, endpoint: Endpoint | undefined, modelId: string | undefined,
}): ModelLaunchTarget | undefined {
  const launch = chat === undefined ? undefined : storageService.getModelLaunch({ chatId: chat.id });
  return launch?.phase === 'active' && endpoint?.type === 'llama_cpp_browser' && modelId === launch.effectiveModelId ? launch.target : undefined;
}

export async function isModelLaunchTargetReady({ target, destination, effectiveModelId, expectedRoot }: { target: ModelLaunchTarget, destination?: DownloadDestination, effectiveModelId?: string, expectedRoot?: FileSystemDirectoryHandle }): Promise<boolean> {
  const model = await installedSelection({ selection: target.selection, destination, ...(expectedRoot === undefined ? {} : { expectedRoot }) });
  return model?.modelId === (effectiveModelId ?? target.modelId);
}

/** Recheck bytes at the generation boundary, not only the visual button. */
export async function assertModelLaunchReady({ chat, endpoint, modelId }: {
  chat: Pick<Chat, 'id' | 'root'>, endpoint: Endpoint, modelId: string | undefined,
}): Promise<{ target: ModelLaunchTarget, effectiveModelId: string } | undefined> {
  const localPreparation = assertLocalModelLaunchReady({ chat, endpoint, modelId });
  const target = applicableModelLaunchTarget({ chat, endpoint, modelId });
  const launch = storageService.getModelLaunch({ chatId: chat.id });
  if (target === undefined && launch?.phase !== 'reserved') {
    switch (endpoint.type) {
    case 'llama_cpp_browser': {
      let available = false;
      try {
        if (modelId) {
          // A reload has no Start receipt. Its ordinary local binding still has
          // to resolve real files before attachments or message trees are saved.
          // The UI's short-lived availability cache is not send authority.
          const { inspectLocalModel } = await import('@/features/llama-cpp-browser/model-recovery/availability');
          const result = await inspectLocalModel({ modelId });
          switch (result) {
          case 'available': available = true;
            break;
          case 'missing': case 'unreadable': break;
          default: {
            const exhaustive: never = result;
            throw new Error(String(exhaustive));
          }
          }
        }
      } catch { /* Storage and permission failures are not permission to send. */ }
      if (!available) {
        throw new Error(await ensureStrings.LlamaCppBrowserModelLaunch__model_not_ready());
      }
      localPreparation?.assertCurrent();
      return undefined;
    }
    case 'openai': case 'ollama': case 'transformers_js': case 'browser_provided_lm': case 'naidan_rpc': case 'unsupported_experimental_endpoint':
      return undefined;
    default: {
      const exhaustive: never = endpoint;
      throw new Error(String(exhaustive));
    }
    }
  }
  const needsInitialPreparation = chat.root.items.length === 0;
  if (target !== undefined && needsInitialPreparation && (launch === undefined || !isModelLaunchPrepared({ chatId: chat.id, target, destination: launch.destination, effectiveModelId: launch.effectiveModelId }))) {
    throw new Error(await ensureStrings.LlamaCppBrowserModelLaunch__model_not_ready());
  }
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
        && storedEndpoint?.type === 'llama_cpp_browser' && storedModel === stored.effectiveModelId
        && await isModelLaunchTargetReady({ target, destination: stored.destination, effectiveModelId: stored.effectiveModelId })
        && (!needsInitialPreparation || isModelLaunchPrepared({ chatId: chat.id, target, destination: stored.destination, effectiveModelId: stored.effectiveModelId }));
    }
  } catch { /* Storage failure is not a fallback authorization. */ }
  if (!ready) {
    throw new Error(await ensureStrings.LlamaCppBrowserModelLaunch__model_not_ready());
  }
  return target === undefined ? undefined : { target, effectiveModelId: modelId! };
}

export const TEST_ONLY = {
};
