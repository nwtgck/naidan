import { getPrivacyFetchBrokerClient } from './broker-client'
import type {
  PrivacyFetchRequest,
  PrivacyFetchResponse,
} from './types'

export async function privacyFetch({
  request,
}: {
  request: PrivacyFetchRequest;
}): Promise<PrivacyFetchResponse> {
  return getPrivacyFetchBrokerClient().fetch({ request })
}
