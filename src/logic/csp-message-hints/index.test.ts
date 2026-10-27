import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CspHintTarget } from './types';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  document.head.querySelectorAll('[data-naidan-developer-csp], #unrelated-csp-test').forEach(element => element.remove());
  vi.restoreAllMocks();
});

async function applyDevelopmentMeta({ serialized }: { serialized: string }): Promise<void> {
  const { getDevelopmentMetaCspOwnerNotForSecurity } = await import('@/logic/development-meta-csp/owner');
  await getDevelopmentMetaCspOwnerNotForSecurity().addForDevelopmentNotForSecurity({ serialized, source: 'developer-action', isCurrent: () => true, isRecoveryResident: () => true });
}

async function observedModule({ serialized }: { serialized: string }) {
  const response = new Response('', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': serialized } });
  const url = new URL(document.location.href);
  url.hash = '';
  Object.defineProperty(response, 'url', { value: url.href });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  const module = await import('./index');
  await module.ensureCspObservationForMessagesOnly();
  return { module, fetcher };
}

describe('read-only HTTP and managed meta observations', () => {
  it('changes hints only from actual additions without changing the observed header cache', async () => {
    const { module, fetcher } = await observedModule({ serialized: 'connect-src *' });
    const target = { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' } as const;
    expect(module.describeCspForUiMessagesOnly({ target })).toBeUndefined();
    expect(document.head.querySelector('meta[data-naidan-developer-csp]')).toBeNull();
    await applyDevelopmentMeta({ serialized: "connect-src 'none'" });
    expect(module.describeCspForUiMessagesOnly({ target })).toBeDefined();
    expect(module.getCspDeveloperSnapshotForDisplayOnly().observation).toMatchObject({ enforce: { serialized: 'connect-src *' } });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not replace actual policy records when a later value fails to parse', async () => {
    const { module } = await observedModule({ serialized: 'connect-src *' });
    await applyDevelopmentMeta({ serialized: "connect-src 'none'" });
    const cached = module.getCspDeveloperSnapshotForDisplayOnly().addedMetaParsed;
    await applyDevelopmentMeta({ serialized: 'x'.repeat(65_537) });
    expect(document.head.querySelectorAll('[data-naidan-developer-csp]')).toHaveLength(1);
    expect(module.getCspDeveloperSnapshotForDisplayOnly().addedMetaParsed?.[0]).toBe(cached?.[0]);
    expect(module.describeCspForUiMessagesOnly({ target: { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' } })).toBeDefined();
  });

  it('adds separate policies, preserves unrelated meta, and does not reparse prior additions', async () => {
    const module = await import('./index');
    const unrelated = document.createElement('meta');
    unrelated.id = 'unrelated-csp-test';
    unrelated.httpEquiv = 'Content-Security-Policy';
    unrelated.content = "img-src 'self'";
    document.head.append(unrelated);
    await applyDevelopmentMeta({ serialized: "connect-src 'self', img-src 'none'" });
    const installed = [...document.head.querySelectorAll<HTMLMetaElement>('meta[data-naidan-developer-csp]')];
    expect(installed.map(meta => meta.content)).toEqual(["connect-src 'self'", " img-src 'none'"]);
    const cachedMetaParse = module.getCspDeveloperSnapshotForDisplayOnly().addedMetaParsed?.[0];
    await applyDevelopmentMeta({ serialized: 'connect-src *' });
    await applyDevelopmentMeta({ serialized: "connect-src 'self', img-src 'none'" });
    expect(document.head.querySelectorAll('meta[data-naidan-developer-csp]')).toHaveLength(3);
    expect(module.getCspDeveloperSnapshotForDisplayOnly().addedMetaParsed).toHaveLength(2);
    expect(module.getCspDeveloperSnapshotForDisplayOnly().addedMetaParsed?.[0]).toBe(cachedMetaParse);
    expect(unrelated.content).toBe("img-src 'self'");
  });

  it('records partially installed policies and suppresses identical repeated additions', async () => {
    const module = await import('./index');
    const { getDevelopmentMetaCspOwnerNotForSecurity } = await import('@/logic/development-meta-csp/owner');
    const native = getDevelopmentMetaCspOwnerNotForSecurity();
    const append = document.head.append.bind(document.head);
    const spy = vi.spyOn(document.head, 'append').mockImplementationOnce((...nodes) => append(...nodes)).mockImplementationOnce(() => {
      throw new Error('injected append failure');
    });
    await applyDevelopmentMeta({ serialized: "connect-src 'self', img-src 'none'" });
    expect(native.getSnapshot().installation).toMatchObject({ kind: 'partly-added', policies: ["connect-src 'self'"] });
    expect(native.getSnapshot().additions).toMatchObject([{ policies: ["connect-src 'self'"] }]);
    expect(module.getCspDeveloperSnapshotForDisplayOnly().addedMetaParsed?.[0]?.policies.map(policy => policy.serialized)).toEqual(["connect-src 'self'"]);
    await applyDevelopmentMeta({ serialized: "connect-src 'self', img-src 'none'" });
    expect(spy).toHaveBeenCalledTimes(2);
    await applyDevelopmentMeta({ serialized: 'connect-src *' });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('preserves external meta while deliberately keeping it outside managed records', async () => {
    const existing = document.createElement('meta');
    existing.setAttribute('data-naidan-developer-csp', '');
    existing.httpEquiv = 'Content-Security-Policy';
    existing.content = "connect-src 'none'";
    document.head.append(existing);
    const module = await import('./index');
    await applyDevelopmentMeta({ serialized: 'connect-src *' });
    expect(existing.content).toBe("connect-src 'none'");
    expect(document.head.querySelectorAll('[data-naidan-developer-csp]')).toHaveLength(2);
    expect(module.getCspDeveloperSnapshotForDisplayOnly().addedMetaParsed?.map(parsed => parsed.serialized)).toEqual(['connect-src *']);
  });

  it('retains every enforced policy through A to B to A without unioning permissions or refetching', async () => {
    const { module, fetcher } = await observedModule({ serialized: 'connect-src *' });
    const target = { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' } as const;
    await applyDevelopmentMeta({ serialized: "connect-src 'none'" });
    expect(module.describeCspForUiMessagesOnly({ target })).toBeDefined();
    await applyDevelopmentMeta({ serialized: 'connect-src *' });
    await applyDevelopmentMeta({ serialized: "connect-src 'none'" });
    expect(module.describeCspForUiMessagesOnly({ target })).toMatchObject({ details: [{ sources: ["'none'"] }] });
    expect(module.getCspDeveloperSnapshotForDisplayOnly().addedMetaParsed).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('clears all existing messages when the managed diagnostic cache becomes incomplete', async () => {
    const { module } = await observedModule({ serialized: "connect-src 'none'" });
    const target = { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' } as const;
    let message = module.describeCspForUiMessagesOnly({ target });
    const unsubscribe = module.subscribeCspMessagesOnly({
      listener: () => {
        message = module.describeCspForUiMessagesOnly({ target });
      },
    });
    expect(message).toBeDefined();
    for (let index = 0; index < 65; index++) {
      await applyDevelopmentMeta({ serialized: `connect-src https://host-${index}.example` });
    }
    expect(document.head.querySelectorAll('[data-naidan-developer-csp]')).toHaveLength(65);
    expect(module.getCspDeveloperSnapshotForDisplayOnly().addedMetaParsed).toBeUndefined();
    expect(message).toBeUndefined();
    expect(module.describeCspForUiMessagesOnly({ target })).toBeUndefined();
    unsubscribe?.();
  });

  it.each(['huggingface-metadata', 'huggingface-download', 'wikipedia'] as const)('prewarns for the next broker and uses only current full acknowledgements after ready: %s', async kind => {
    const { module, fetcher } = await observedModule({ serialized: 'connect-src *' });
    const { getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity } = await import('@/logic/development-meta-csp/privacy-broker-sync');
    const { getDevelopmentMetaCspForNextPrivacyBrokerRequestHintsOnly } = await import('@/logic/development-meta-csp/document-messages-only');
    const { getDevelopmentMetaCspOwnerNotForSecurity } = await import('@/logic/development-meta-csp/owner');
    const native = getDevelopmentMetaCspOwnerNotForSecurity();
    const sync = getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity();
    const target: CspHintTarget = { kind };
    let message = module.describeCspForUiMessagesOnly({ target });
    const unsubscribe = module.subscribeCspMessagesOnly({
      listener: () => {
        message = module.describeCspForUiMessagesOnly({ target });
      },
    });
    await applyDevelopmentMeta({ serialized: "connect-src 'none'" });
    expect(message?.details).toMatchObject([{ directive: 'connect-src', context: 'privacy-broker' }]);
    expect(native.getSnapshot().privacyBroker.kind).toBe('not-created');
    expect(getDevelopmentMetaCspForNextPrivacyBrokerRequestHintsOnly().basis).toBe('next-broker');
    expect(document.querySelector('iframe')).toBeNull();
    sync.beginSession({ sessionId: 'session-1' });
    sync.recordSending({ sessionId: 'session-1', syncId: 'sync-1', policyCount: 1 });
    expect(message).toBeUndefined();
    sync.recordResult({ sessionId: 'session-1', syncId: 'sync-1', confirmedPolicyCount: 1, outcome: 'added' });
    expect(message?.details).toMatchObject([{ directive: 'connect-src', context: 'privacy-broker' }]);
    await applyDevelopmentMeta({ serialized: 'connect-src *' });
    expect(message).toBeUndefined();
    sync.recordSending({ sessionId: 'session-1', syncId: 'sync-2', policyCount: 2 });
    sync.recordResult({ sessionId: 'session-1', syncId: 'sync-1', confirmedPolicyCount: 1, outcome: 'added' });
    expect(message).toBeUndefined();
    sync.recordSendFailure({ sessionId: 'session-1', syncId: 'sync-2' });
    expect(message).toBeUndefined();
    expect(getDevelopmentMetaCspForNextPrivacyBrokerRequestHintsOnly().basis).toBe('unconfirmed-current-broker');
    sync.recordSending({ sessionId: 'session-1', syncId: 'sync-3', policyCount: 2 });
    sync.recordResult({ sessionId: 'session-1', syncId: 'sync-3', confirmedPolicyCount: 2, outcome: 'added' });
    expect(message?.details).toMatchObject([{ sources: ["'none'"], context: 'privacy-broker' }]);
    sync.disposeSession({ sessionId: 'session-1' });
    expect(message?.details).toMatchObject([{ directive: 'connect-src', context: 'privacy-broker' }]);
    expect(native.getSnapshot().privacyBroker.kind).toBe('not-created');
    expect(getDevelopmentMetaCspForNextPrivacyBrokerRequestHintsOnly().basis).toBe('next-broker');
    expect(fetcher).toHaveBeenCalledOnce();
    unsubscribe?.();
  });

  it('does not blame a ready broker fetch on later frame, script or frame-ancestors meta restrictions', async () => {
    const { module } = await observedModule({ serialized: '' });
    const { getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity } = await import('@/logic/development-meta-csp/privacy-broker-sync');
    const sync = getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity();
    sync.beginSession({ sessionId: 'session-1' });
    await applyDevelopmentMeta({ serialized: "frame-src 'none'; script-src 'none'; frame-ancestors 'none'" });
    sync.recordSending({ sessionId: 'session-1', syncId: 'sync-1', policyCount: 1 });
    sync.recordResult({ sessionId: 'session-1', syncId: 'sync-1', confirmedPolicyCount: 1, outcome: 'added' });
    expect(module.describeCspForUiMessagesOnly({ target: { kind: 'wikipedia' } })).toBeUndefined();
  });
});
