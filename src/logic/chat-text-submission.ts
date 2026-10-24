import { isConfiguredEndpoint } from '@/01-models/endpoint';
import type { Endpoint } from '@/01-models/types';

export type ChatTextSubmissionAction = 'send' | 'select-model' | 'blocked';

/** Model selection writes a chat override, regardless of which inherited
 * setting is incomplete. The existing resolver remains the source of truth. */
export function resolveChatTextSubmissionAction({ endpoint, modelId, canSubmit }: {
  endpoint: Endpoint,
  modelId: string,
  canSubmit: boolean,
}): ChatTextSubmissionAction {
  if (!isConfiguredEndpoint({ endpoint }) || !modelId) {
    return 'select-model';
  }
  return canSubmit ? 'send' : 'blocked';
}

export const TEST_ONLY = {
};
