import { describe, expect, it } from 'vitest';
import {
  privacyFetchBrokerToParentMessageSchema,
  TEST_ONLY as PRIVACY_FETCH_SCHEMAS_TEST_ONLY,
} from './schemas';
import { PRIVACY_FETCH_PROTOCOL } from './protocol';

describe('privacy fetch schemas', () => {
  it('accepts request messages', () => {
    expect(PRIVACY_FETCH_SCHEMAS_TEST_ONLY.privacyFetchParentToBrokerMessageSchema.parse({
      protocol: PRIVACY_FETCH_PROTOCOL,
      type: 'request',
      requestId: 'req-1',
      url: 'https://en.wikipedia.org/w/api.php?origin=*',
    })).toMatchObject({
      type: 'request',
      requestId: 'req-1',
    });
  });

  it('accepts header entries arrays', () => {
    expect(PRIVACY_FETCH_SCHEMAS_TEST_ONLY.privacyFetchHeaderEntriesSchema.parse([
      ['content-type', 'application/json'],
      ['cache-control', 'no-store'],
    ])).toHaveLength(2);
  });

  it('accepts response messages with transferred array buffers', () => {
    const body = new TextEncoder().encode('hello').buffer;
    expect(privacyFetchBrokerToParentMessageSchema.parse({
      protocol: PRIVACY_FETCH_PROTOCOL,
      type: 'response',
      requestId: 'req-1',
      ok: true,
      responseOk: true,
      url: 'https://en.wikipedia.org/w/api.php?origin=*',
      status: 200,
      statusText: 'OK',
      redirected: false,
      responseType: 'cors',
      headers: [['content-type', 'application/json']],
      body,
      bodyByteLength: body.byteLength,
      validationResult: {
        ok: true,
        policyName: 'wikipedia_api',
        normalizedUrl: 'https://en.wikipedia.org/w/api.php?origin=*',
      },
    })).toMatchObject({
      type: 'response',
      requestId: 'req-1',
    });
  });
});
