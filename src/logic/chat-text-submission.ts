import { isConfiguredEndpoint } from '@/01-models/endpoint';
import type { Endpoint } from '@/01-models/types';
import type { SettingsSource } from '@/logic/settings-labels';

export type ChatTextSubmissionAction = 'send' | 'open-onboarding' | 'blocked';

/** Missing inherited chat setup is recoverable through global onboarding.
 * A broken chat/group override must not open a global-only editor. */
export function resolveChatTextSubmissionAction({
  endpoint,
  modelId,
  endpointSource,
  modelSource,
  globalSetupIncomplete,
  canSubmit,
}: {
  endpoint: Endpoint,
  modelId: string,
  endpointSource: SettingsSource,
  modelSource: SettingsSource,
  globalSetupIncomplete: boolean,
  canSubmit: boolean,
}): ChatTextSubmissionAction {
  if (!isConfiguredEndpoint({ endpoint })) {
    return globalSetupIncomplete && endpointSource === 'global' ? 'open-onboarding' : 'blocked';
  }
  if (!modelId) {
    return globalSetupIncomplete && modelSource === 'global' ? 'open-onboarding' : 'blocked';
  }
  return canSubmit ? 'send' : 'blocked';
}

export const TEST_ONLY = {
};
