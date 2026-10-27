import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity } from '@/logic/development-meta-csp/privacy-broker-sync';
import { TEST_ONLY as brokerClient } from './broker-client';
import { PRIVACY_FETCH_PROTOCOL } from './protocol';
import { developmentMetaCspSyncMessageSchema } from './development-meta-csp-protocol';
import { privacyFetchRequestMessageSchema } from './schemas';
import { streamRequestSchema } from './stream-protocol';

type SyncOwner = ReturnType<typeof getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity>;

const { owner, getOwner, unsubscribe } = vi.hoisted(() => ({
  owner: {
    beginSession: vi.fn<SyncOwner['beginSession']>(),
    getSuccessfulPolicies: vi.fn<SyncOwner['getSuccessfulPolicies']>(),
    subscribeSuccessfulAdditions: vi.fn<SyncOwner['subscribeSuccessfulAdditions']>(),
    recordSending: vi.fn<SyncOwner['recordSending']>(),
    recordSendFailure: vi.fn<SyncOwner['recordSendFailure']>(),
    recordResult: vi.fn<SyncOwner['recordResult']>(),
    disposeSession: vi.fn<SyncOwner['disposeSession']>(),
  },
  getOwner: vi.fn<typeof getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity>(),
  unsubscribe: vi.fn<() => void>(),
}));

vi.mock('@/logic/development-meta-csp/privacy-broker-sync', () => ({ getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity: getOwner }));

let notifyAddition: (() => void) | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  getOwner.mockReturnValue(owner);
  owner.getSuccessfulPolicies.mockReturnValue([]);
  owner.subscribeSuccessfulAdditions.mockImplementation(({ listener }) => {
    notifyAddition = listener;
    return unsubscribe;
  });
  notifyAddition = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createHarness() {
  const postMessage = vi.fn<Window['postMessage']>();
  const brokerWindow = { postMessage } as unknown as WindowProxy;
  const iframe = document.createElement('iframe');
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: brokerWindow });
  const client = brokerClient.createPrivacyFetchBrokerClient({ createBrokerIframeImpl: () => iframe, windowObject: window, documentObject: document });
  const dispatch = ({ data, source }: { data: unknown, source: WindowProxy }) => window.dispatchEvent(new MessageEvent('message', { data, source }));
  return {
    client,
    postMessage,
    brokerWindow,
    ready() {
      dispatch({ source: brokerWindow, data: { protocol: PRIVACY_FETCH_PROTOCOL, type: 'ready', capabilities: { responseBody: 'arrayBuffer', transferArrayBuffer: true, headers: 'entries' } } });
    },
    syncs() {
      return postMessage.mock.calls.flatMap(([data]) => {
        const parsed = developmentMetaCspSyncMessageSchema.safeParse(data);
        return parsed.success ? [parsed.data] : [];
      });
    },
    requests() {
      return postMessage.mock.calls.flatMap(([data]) => {
        const parsed = privacyFetchRequestMessageSchema.safeParse(data);
        return parsed.success ? [parsed.data] : [];
      });
    },
    dispatch,
    respond({ requestId }: { requestId: string }) {
      dispatch({
        source: brokerWindow,
        data: {
          protocol: PRIVACY_FETCH_PROTOCOL,
          type: 'response',
          requestId,
          ok: true,
          responseOk: true,
          url: 'https://en.wikipedia.org/w/api.php?origin=*',
          status: 200,
          statusText: 'OK',
          redirected: false,
          responseType: 'cors',
          headers: [],
          body: new ArrayBuffer(0),
          bodyByteLength: 0,
          validationResult: { ok: true, policyName: 'wikipedia_api', normalizedUrl: 'https://en.wikipedia.org/w/api.php?origin=*' },
        },
      });
    },
    [Symbol.dispose]() {
      client.dispose();
    },
  };
}

const request = { url: 'https://en.wikipedia.org/w/api.php?origin=*', signal: undefined, headers: undefined };

describe('privacy broker development meta CSP synchronization', () => {
  it('leaves the previous request message count and payload unchanged when history is empty', async () => {
    using harness = createHarness();
    harness.ready();
    const response = harness.client.fetch({ request });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    expect(harness.postMessage).toHaveBeenCalledTimes(1);
    const posted = harness.requests()[0];
    expect(posted).toEqual({ protocol: PRIVACY_FETCH_PROTOCOL, type: 'request', requestId: expect.any(String), url: request.url });
    if (posted === undefined) {
      throw new Error('Missing request');
    }
    harness.respond({ requestId: posted.requestId });
    await expect(response).resolves.toMatchObject({ status: 200 });
  });

  it('uses the latest preparing history, sends it before a buffered request, and never waits for ACK', async () => {
    using harness = createHarness();
    const response = harness.client.fetch({ request });
    expect(getOwner).not.toHaveBeenCalled();
    owner.getSuccessfulPolicies.mockReturnValue(['A', 'B']);
    harness.ready();
    expect(harness.syncs()).toHaveLength(1);
    expect(harness.syncs()[0]?.policies).toEqual(['A', 'B']);
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    expect(developmentMetaCspSyncMessageSchema.safeParse(harness.postMessage.mock.calls[0]?.[0]).success).toBe(true);
    expect(privacyFetchRequestMessageSchema.safeParse(harness.postMessage.mock.calls[1]?.[0]).success).toBe(true);
    expect(owner.recordResult).not.toHaveBeenCalled();
    const posted = harness.requests()[0];
    if (posted === undefined) {
      throw new Error('Missing request');
    }
    harness.respond({ requestId: posted.requestId });
    await expect(response).resolves.toMatchObject({ status: 200 });
  });

  it('sends full snapshots only on successful-addition notifications, and unsubscribes on dispose', () => {
    using harness = createHarness();
    owner.getSuccessfulPolicies.mockReturnValue(['A']);
    harness.ready();
    owner.getSuccessfulPolicies.mockReturnValue(['A', 'B']);
    notifyAddition?.();
    expect(harness.syncs().map(sync => sync.policies)).toEqual([['A'], ['A', 'B']]);
    expect(owner.subscribeSuccessfulAdditions).toHaveBeenCalledOnce();
    const listener = notifyAddition;
    harness.client.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(owner.disposeSession).toHaveBeenCalledWith({ sessionId: harness.syncs()[0]?.sessionId });
    listener?.();
    expect(harness.syncs()).toHaveLength(2);
  });

  it('starts a fresh confirmation session on re-ready and forwards count-only ACKs without resending', () => {
    using harness = createHarness();
    owner.getSuccessfulPolicies.mockReturnValue(['A']);
    harness.ready();
    const first = harness.syncs()[0];
    harness.ready();
    const second = harness.syncs()[1];
    if (first === undefined || second === undefined) {
      throw new Error('Missing synchronization');
    }
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(owner.subscribeSuccessfulAdditions).toHaveBeenCalledOnce();
    const ack = { protocol: PRIVACY_FETCH_PROTOCOL, type: 'development-meta-csp-result', sessionId: first.sessionId, syncId: first.syncId, confirmedPolicyCount: 1, outcome: 'added' };
    harness.dispatch({ data: ack, source: harness.brokerWindow });
    expect(owner.recordResult).toHaveBeenCalledExactlyOnceWith({ sessionId: first.sessionId, syncId: first.syncId, confirmedPolicyCount: 1, outcome: 'added' });
    expect(harness.syncs()).toHaveLength(2);
    // The owner rejects obsolete identifiers; the transport does not interpret
    // these display-only results or alter normal requests in response to them.
  });

  it('ignores malformed and wrong-source ACKs, and drops delayed ACKs after disposal', () => {
    using harness = createHarness();
    owner.getSuccessfulPolicies.mockReturnValue(['A']);
    harness.ready();
    const sync = harness.syncs()[0];
    if (sync === undefined) {
      throw new Error('Missing synchronization');
    }
    const ack = { protocol: PRIVACY_FETCH_PROTOCOL, type: 'development-meta-csp-result', sessionId: sync.sessionId, syncId: sync.syncId, confirmedPolicyCount: 1, outcome: 'added' };
    harness.dispatch({ data: ack, source: window });
    harness.dispatch({ data: { ...ack, confirmedPolicyCount: -1 }, source: harness.brokerWindow });
    harness.dispatch({ data: { ...ack, rawPolicies: ['A'] }, source: harness.brokerWindow });
    harness.client.dispose();
    harness.dispatch({ data: ack, source: harness.brokerWindow });
    expect(owner.recordResult).not.toHaveBeenCalled();
  });

  it.each(['owner', 'begin', 'subscribe', 'getter', 'sending', 'send', 'failure-publish'] as const)('still resolves normal readiness when %s throws', async failure => {
    using harness = createHarness();
    owner.getSuccessfulPolicies.mockReturnValue(['A']);
    const fail = () => {
      throw new Error('development-only failure');
    };
    switch (failure) {
    case 'owner': getOwner.mockImplementationOnce(fail);
      break;
    case 'begin': owner.beginSession.mockImplementationOnce(fail);
      break;
    case 'subscribe': owner.subscribeSuccessfulAdditions.mockImplementationOnce(fail);
      break;
    case 'getter': owner.getSuccessfulPolicies.mockImplementationOnce(fail);
      break;
    case 'sending': owner.recordSending.mockImplementationOnce(fail);
      break;
    case 'send': harness.postMessage.mockImplementationOnce(fail);
      break;
    case 'failure-publish': harness.postMessage.mockImplementationOnce(fail);
      owner.recordSendFailure.mockImplementationOnce(fail);
      break;
    default: {
      const exhaustive: never = failure;
      throw exhaustive;
    }
    }
    const response = harness.client.fetch({ request });
    harness.ready();
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    const posted = harness.requests()[0];
    if (posted === undefined) {
      throw new Error('Missing request');
    }
    harness.respond({ requestId: posted.requestId });
    await expect(response).resolves.toMatchObject({ status: 200 });
  });

  it('does not let ACK publication errors affect a subsequent request', async () => {
    using harness = createHarness();
    owner.getSuccessfulPolicies.mockReturnValue(['A']);
    harness.ready();
    const sync = harness.syncs()[0];
    if (sync === undefined) {
      throw new Error('Missing synchronization');
    }
    owner.recordResult.mockImplementationOnce(() => {
      throw new Error('publication failed');
    });
    expect(() => harness.dispatch({ source: harness.brokerWindow, data: { protocol: PRIVACY_FETCH_PROTOCOL, type: 'development-meta-csp-result', sessionId: sync.sessionId, syncId: sync.syncId, confirmedPolicyCount: 1, outcome: 'added' } })).not.toThrow();
    const response = harness.client.fetch({ request });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    const posted = harness.requests()[0];
    if (posted === undefined) {
      throw new Error('Missing request');
    }
    harness.respond({ requestId: posted.requestId });
    await response;
  });

  it('posts an unchanged stream request after synchronization without any ACK', async () => {
    using harness = createHarness();
    owner.getSuccessfulPolicies.mockReturnValue(['A']);
    const response = harness.client.fetchStream({ request: { ...request, url: 'https://huggingface.co/api/models/owner/model' } });
    harness.ready();
    await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledTimes(2));
    const call = harness.postMessage.mock.calls[1];
    expect(streamRequestSchema.parse(call?.[0])).toEqual({ protocol: PRIVACY_FETCH_PROTOCOL, type: 'stream-request', url: 'https://huggingface.co/api/models/owner/model' });
    expect(call?.[1]).toBe('*');
    expect(Array.from(call ?? [])[2]).toHaveLength(1);
    expect(owner.recordResult).not.toHaveBeenCalled();
    harness.client.dispose();
    await expect(response).rejects.toMatchObject({ code: 'broker_disposed' });
  });
});
