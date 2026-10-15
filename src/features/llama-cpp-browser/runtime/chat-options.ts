import { storageService } from '@/00-storage/service';
import { parseRuntimeOptions } from './profile-policy';
import type { RuntimeOptions } from '@/features/llama-cpp-browser/types';

/** Capture the chat allocation request before entering the native lane. Audio
 * uses its own bounded context; never apply this preference to audio requests.
 * Explicit caller options (including measurements) override the stored value. */
export function captureChatOptions({ options }: { options: RuntimeOptions }): Promise<RuntimeOptions> {
  const accepted = parseRuntimeOptions({ options });
  const pending = accepted.contextTokens !== undefined ? Promise.resolve(accepted) : storageService.loadSettings().then(settings => {
    const contextTokens = settings?.experimental?.llamaCppBrowser?.contextTokens;
    return contextTokens === undefined ? accepted : parseRuntimeOptions({ options: { ...accepted, contextTokens } });
  });
  // Acceptance can be superseded by a cancelled/skipped warmup. Its storage
  // read still settles; the lane owner observes errors when it awaits pending.
  void pending.catch(() => {});
  return pending;
}

export const TEST_ONLY = {
};
