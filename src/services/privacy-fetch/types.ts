import type { PRIVACY_FETCH_PROTOCOL } from './protocol';

export type PrivacyFetchRequest = {
  url: string,
  signal?: AbortSignal,
};

export type PrivacyFetchHeaderEntries = Array<[string, string]>;

export type PrivacyFetchValidationAcceptedResult = {
  ok: true,
  policyName: string,
  normalizedUrl: string,
};

export type PrivacyFetchValidationRejectedCode =
  | 'invalid_url'
  | 'invalid_protocol'
  | 'invalid_username_or_password'
  | 'invalid_port'
  | 'invalid_hash'
  | 'invalid_hostname'
  | 'invalid_pathname'
  | 'invalid_query_parameter'
  | 'duplicate_query_parameter'
  | 'invalid_query_parameter_value'
  | 'unsupported_policy';

export type PrivacyFetchValidationRejectedResult = {
  ok: false,
  code: PrivacyFetchValidationRejectedCode,
  message: string,
};

export type PrivacyFetchValidationResult =
  | PrivacyFetchValidationAcceptedResult
  | PrivacyFetchValidationRejectedResult;

export type PrivacyFetchResponse = {
  url: string,
  status: number,
  statusText: string,
  ok: boolean,
  redirected: boolean,
  responseType: string,
  headers: Headers,
  body: ArrayBuffer,
  bodyByteLength: number,
  policyName: string,
};

export type PrivacyFetchRequestMessage = {
  protocol: typeof PRIVACY_FETCH_PROTOCOL,
  type: 'request',
  requestId: string,
  url: string,
};

export type PrivacyFetchCancelMessage = {
  protocol: typeof PRIVACY_FETCH_PROTOCOL,
  type: 'cancel',
  requestId: string,
};

export type PrivacyFetchReadyMessage = {
  protocol: typeof PRIVACY_FETCH_PROTOCOL,
  type: 'ready',
  capabilities: {
    responseBody: 'arrayBuffer',
    transferArrayBuffer: true,
    headers: 'entries',
  },
};

export type PrivacyFetchResponseMessage = {
  protocol: typeof PRIVACY_FETCH_PROTOCOL,
  type: 'response',
  requestId: string,
  ok: true,
  responseOk: boolean,
  url: string,
  status: number,
  statusText: string,
  redirected: boolean,
  responseType: string,
  headers: PrivacyFetchHeaderEntries,
  body: ArrayBuffer,
  bodyByteLength: number,
  validationResult: PrivacyFetchValidationAcceptedResult,
};

export type PrivacyFetchRejectedMessage = {
  protocol: typeof PRIVACY_FETCH_PROTOCOL,
  type: 'rejected',
  requestId: string,
  ok: false,
  validationResult: PrivacyFetchValidationRejectedResult,
};

export type PrivacyFetchErrorCode =
  | 'fetch_failed'
  | 'aborted'
  | 'duplicate_request_id';

export type PrivacyFetchErrorMessage = {
  protocol: typeof PRIVACY_FETCH_PROTOCOL,
  type: 'error',
  requestId: string,
  ok: false,
  code: PrivacyFetchErrorCode,
  message: string,
};

export type PrivacyFetchParentToBrokerMessage =
  | PrivacyFetchRequestMessage
  | PrivacyFetchCancelMessage;

export type PrivacyFetchBrokerToParentMessage =
  | PrivacyFetchReadyMessage
  | PrivacyFetchResponseMessage
  | PrivacyFetchRejectedMessage
  | PrivacyFetchErrorMessage;

export type PrivacyFetchBrokerClient = {
  fetch({ request }: { request: PrivacyFetchRequest }): Promise<PrivacyFetchResponse>,
  dispose(): void,
};
