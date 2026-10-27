import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCsp } from '@/utils/csp';
import { createDevelopmentMetaCspOwnerNotForSecurity } from './owner';

afterEach(() => {
  document.head.querySelectorAll('[data-naidan-developer-csp]').forEach(element => element.remove());
  vi.restoreAllMocks();
});

function fixture() {
  const parser = vi.fn(parseCsp);
  const owner = createDevelopmentMetaCspOwnerNotForSecurity({ environment: { document, loadParser: async () => parser } });
  return {
    owner,
    parser,
    add({ serialized }: { serialized: string }) {
      return owner.addForDevelopmentNotForSecurity({ serialized, source: 'developer-action', isCurrent: () => true, isRecoveryResident: () => true });
    },
  };
}

describe('confirmed development meta for the current privacy broker', () => {
  it('records an empty ready broker without fetching or requiring a control message', () => {
    const { owner, parser } = fixture();
    expect(owner.getSnapshot().privacyBroker.kind).toBe('not-created');
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly()).toEqual({ lifetime: 'not-created', basis: 'next-broker', metas: [] });
    owner.beginSession({ sessionId: 'session-1' });
    expect(owner.getSnapshot().privacyBroker).toMatchObject({ kind: 'confirmed', requestedPolicyCount: 0, confirmedPolicyCount: 0 });
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly()).toEqual({ lifetime: 'ready', basis: 'confirmed-current-broker', metas: [] });
    expect(parser).not.toHaveBeenCalled();
  });

  it('synchronizes only raw policies actually appended in the parent and notifies only raw changes', async () => {
    const { owner } = fixture();
    const listener = vi.fn();
    const unsubscribe = owner.subscribeSuccessfulAdditions({ listener });
    const append = document.head.append.bind(document.head);
    vi.spyOn(document.head, 'append').mockImplementationOnce((...nodes) => append(...nodes)).mockImplementationOnce(() => {
      throw new Error('second policy append failed');
    });
    await owner.addForDevelopmentNotForSecurity({ serialized: "connect-src 'none', img-src 'none'", source: 'developer-action', isCurrent: () => true, isRecoveryResident: () => true });
    expect(owner.getSuccessfulPolicies()).toEqual(["connect-src 'none'"]);
    owner.beginSession({ sessionId: 'session-1' });
    owner.recordSending({ sessionId: 'session-1', syncId: 'sync-1', policyCount: 1 });
    owner.recordResult({ sessionId: 'session-1', syncId: 'sync-1', confirmedPolicyCount: 1, outcome: 'added' });
    await owner.addForDevelopmentNotForSecurity({ serialized: "connect-src 'none', img-src 'none'", source: 'developer-action', isCurrent: () => true, isRecoveryResident: () => true });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe?.();
  });

  it('reuses cached AST only after complete current confirmation and invalidates it before raw notifications', async () => {
    const { owner, parser, add } = fixture();
    await add({ serialized: "connect-src 'none'" });
    const planned = owner.getPrivacyBrokerForNextRequestHintsOnly();
    expect(planned).toMatchObject({ lifetime: 'not-created', basis: 'next-broker' });
    expect(planned.metas).toBe(owner.getAppliedForDocumentMessagesOnly());
    expect(planned.metas?.map(meta => meta.serialized)).toEqual(["connect-src 'none'"]);
    expect(owner.getSnapshot().privacyBroker.kind).toBe('not-created');
    owner.beginSession({ sessionId: 'session-1' });
    owner.recordSending({ sessionId: 'session-1', syncId: 'sync-1', policyCount: 1 });
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly()).toEqual({ lifetime: 'ready', basis: 'unconfirmed-current-broker', metas: undefined });
    owner.recordResult({ sessionId: 'session-1', syncId: 'sync-1', confirmedPolicyCount: 1, outcome: 'added' });
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly().metas).toBe(owner.getAppliedForDocumentMessagesOnly());
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly().basis).toBe('confirmed-current-broker');
    let atRawNotification: unknown;
    const unsubscribe = owner.subscribeSuccessfulAdditions({
      listener: () => {
        atRawNotification = owner.getSnapshot().privacyBroker;
      },
    });
    await add({ serialized: 'connect-src *' });
    expect(atRawNotification).toMatchObject({ kind: 'pending', syncId: undefined, requestedPolicyCount: 2 });
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly()).toEqual({ lifetime: 'ready', basis: 'unconfirmed-current-broker', metas: undefined });
    owner.recordSending({ sessionId: 'session-1', syncId: 'sync-2', policyCount: 2 });
    owner.recordResult({ sessionId: 'session-1', syncId: 'sync-1', confirmedPolicyCount: 1, outcome: 'added' });
    owner.recordSendFailure({ sessionId: 'session-1', syncId: 'sync-1' });
    expect(owner.getSnapshot().privacyBroker.kind).toBe('pending');
    owner.recordResult({ sessionId: 'session-1', syncId: 'sync-2', confirmedPolicyCount: 2, outcome: 'added' });
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly().metas).toBe(owner.getAppliedForDocumentMessagesOnly());
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly().basis).toBe('confirmed-current-broker');
    expect(parser).toHaveBeenCalledTimes(2);
    unsubscribe?.();
  });

  it('does not restore a failed prefix by treating a short later result as full success', async () => {
    const { owner, add } = fixture();
    await add({ serialized: "connect-src 'none', img-src 'none'" });
    owner.beginSession({ sessionId: 'session-1' });
    owner.recordSending({ sessionId: 'session-1', syncId: 'sync-1', policyCount: 2 });
    owner.recordResult({ sessionId: 'session-1', syncId: 'sync-1', confirmedPolicyCount: 1, outcome: 'partly-added' });
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly()).toEqual({ lifetime: 'ready', basis: 'unconfirmed-current-broker', metas: undefined });
    owner.recordSending({ sessionId: 'session-1', syncId: 'sync-2', policyCount: 2 });
    owner.recordResult({ sessionId: 'session-1', syncId: 'sync-2', confirmedPolicyCount: 1, outcome: 'added' });
    expect(owner.getSnapshot().privacyBroker.kind).toBe('unavailable');
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly()).toEqual({ lifetime: 'ready', basis: 'unconfirmed-current-broker', metas: undefined });
  });

  it.each([-1, 2, NaN, 0.5])('rejects an invalid acknowledgement count: %s', async confirmedPolicyCount => {
    const { owner, add } = fixture();
    await add({ serialized: "connect-src 'none'" });
    owner.beginSession({ sessionId: 'session-1' });
    owner.recordSending({ sessionId: 'session-1', syncId: 'sync-1', policyCount: 1 });
    owner.recordResult({ sessionId: 'session-1', syncId: 'sync-1', confirmedPolicyCount, outcome: 'added' });
    expect(owner.getSnapshot().privacyBroker).toMatchObject({ kind: 'unavailable', reason: 'invalid-result' });
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly()).toEqual({ lifetime: 'ready', basis: 'unconfirmed-current-broker', metas: undefined });
  });

  it('does not carry confirmation, delayed results, or old disposal across ready sessions', async () => {
    const { owner, add } = fixture();
    await add({ serialized: "connect-src 'none'" });
    owner.beginSession({ sessionId: 'session-1' });
    owner.recordSending({ sessionId: 'session-1', syncId: 'sync-1', policyCount: 1 });
    owner.recordResult({ sessionId: 'session-1', syncId: 'sync-1', confirmedPolicyCount: 1, outcome: 'added' });
    owner.beginSession({ sessionId: 'session-2' });
    owner.recordResult({ sessionId: 'session-1', syncId: 'sync-1', confirmedPolicyCount: 1, outcome: 'added' });
    owner.disposeSession({ sessionId: 'session-1' });
    expect(owner.getSnapshot().privacyBroker).toMatchObject({ sessionId: 'session-2', kind: 'pending', confirmedPolicyCount: 0 });
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly()).toEqual({ lifetime: 'ready', basis: 'unconfirmed-current-broker', metas: undefined });
    owner.disposeSession({ sessionId: 'session-2' });
    expect(owner.getSuccessfulPolicies()).toEqual(["connect-src 'none'"]);
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly()).toMatchObject({ lifetime: 'not-created', basis: 'next-broker' });
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly().metas).toBe(owner.getAppliedForDocumentMessagesOnly());
  });

  it('records a failure before recordSending and invalidates later raw changes without a subscriber', async () => {
    const { owner, add } = fixture();
    await add({ serialized: "connect-src 'none'" });
    owner.beginSession({ sessionId: 'session-1' });
    owner.recordSendFailure({ sessionId: 'session-1', syncId: 'sync-1' });
    expect(owner.getSnapshot().privacyBroker).toMatchObject({ kind: 'unavailable', reason: 'send-failed' });
    await add({ serialized: 'connect-src *' });
    expect(owner.getSnapshot().privacyBroker).toMatchObject({ kind: 'pending', syncId: undefined, requestedPolicyCount: 2 });
  });

  it('retains raw synchronization after the diagnostic AST budget is exhausted', async () => {
    const { owner, parser, add } = fixture();
    await add({ serialized: Array.from({ length: 65 }, (_, index) => `connect-src https://host-${index}.example`).join(', ') });
    expect(owner.getSuccessfulPolicies()).toHaveLength(65);
    expect(owner.getAppliedForDocumentMessagesOnly()).toBeUndefined();
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly().metas).toBeUndefined();
    owner.beginSession({ sessionId: 'session-1' });
    owner.recordSending({ sessionId: 'session-1', syncId: 'sync-1', policyCount: 65 });
    owner.recordResult({ sessionId: 'session-1', syncId: 'sync-1', confirmedPolicyCount: 65, outcome: 'added' });
    expect(owner.getSnapshot().privacyBroker.kind).toBe('confirmed');
    expect(owner.getPrivacyBrokerForNextRequestHintsOnly()).toEqual({ lifetime: 'ready', basis: 'confirmed-current-broker', metas: undefined });
    expect(parser).toHaveBeenCalledOnce();
  });
});
