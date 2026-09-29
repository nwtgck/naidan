import type { PrivacyFetchRequest, PrivacyFetchStreamResponse } from './types';
import { getPrivacyFetchBrokerClient } from './broker-client';
import type {
  PrivacyFetchResponse,
} from './types';

export async function privacyFetch({
  request,
}: {
  request: PrivacyFetchRequest,
}): Promise<PrivacyFetchResponse> {
  return getPrivacyFetchBrokerClient().fetch({ request });
}

export function privacyFetchStream({ request }: { request: PrivacyFetchRequest }): Promise<PrivacyFetchStreamResponse> {
  return getPrivacyFetchBrokerClient().fetchStream({ request });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
