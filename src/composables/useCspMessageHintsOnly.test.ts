import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, shallowRef } from 'vue';
import { flushPromises } from '@vue/test-utils';
import type { CspHintTarget } from '@/logic/csp-message-hints/types';

afterEach(() => {
  vi.doUnmock('@/logic/csp-message-hints');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('optional CSP presentation composable', () => {
  it('does not load or observe for undefined targets, then starts without waiting for feature work', async () => {
    const ensure = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = vi.fn();
    vi.doMock('@/logic/csp-message-hints', () => ({
      ensureCspObservationForMessagesOnly: ensure,
      subscribeCspMessagesOnly: vi.fn().mockReturnValue(unsubscribe),
      describeCspForUiMessagesOnly: vi.fn(({ target }: { target: CspHintTarget | undefined }) => target === undefined ? undefined : { tone: 'caution', subject: 'connection', details: [], suggestedDeployments: [] }),
    }));
    const { useCspMessageHintsOnly } = await import('./useCspMessageHintsOnly');
    const target = shallowRef<CspHintTarget>();
    const scope = effectScope();
    using cleanup = {
      [Symbol.dispose]() {
        scope.stop();
      },
    };
    const message = scope.run(() => useCspMessageHintsOnly({ target }));
    await flushPromises();
    expect(ensure).not.toHaveBeenCalled();
    expect(message?.value).toBeUndefined();
    target.value = { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' };
    await nextTick();
    await flushPromises();
    expect(ensure).toHaveBeenCalledOnce();
    expect(message?.value).toMatchObject({ tone: 'caution' });
    target.value = undefined;
    await nextTick();
    expect(message?.value).toBeUndefined();
  });

  it('contains optional module loading failure without producing a normal hint', async () => {
    vi.doMock('@/logic/csp-message-hints', () => {
      throw new Error('injected module failure');
    });
    const { useCspMessageHintsOnly, useCachedCspParseResultForDeveloperDisplayOnly } = await import('./useCspMessageHintsOnly');
    const scope = effectScope();
    using cleanup = {
      [Symbol.dispose]() {
        scope.stop();
      },
    };
    const message = scope.run(() => useCspMessageHintsOnly({ target: shallowRef<CspHintTarget>({ kind: 'wikipedia' }) }));
    const developer = scope.run(() => useCachedCspParseResultForDeveloperDisplayOnly());
    await flushPromises();
    expect(message?.value).toBeUndefined();
    expect(developer?.snapshot.value.observation).toStrictEqual({ kind: 'unavailable', reason: 'module-failed', capturedHeaders: undefined });
  });

  it('never shows a message for an unsubscribed consumer beyond the listener budget', async () => {
    const response = new Response('', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "connect-src 'none'" } });
    const responseUrl = new URL(document.location.href);
    responseUrl.hash = '';
    Object.defineProperty(response, 'url', { value: responseUrl.href });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const core = await import('@/logic/csp-message-hints');
    const { useCspMessageHintsOnly } = await import('./useCspMessageHintsOnly');
    await core.ensureCspObservationForMessagesOnly();
    const target: CspHintTarget = { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' };
    expect(core.describeCspForUiMessagesOnly({ target })).toMatchObject({ tone: 'caution' });
    const scope = effectScope();
    using cleanup = {
      [Symbol.dispose]() {
        scope.stop();
      },
    };
    const messages = scope.run(() => Array.from({ length: 513 }, () => useCspMessageHintsOnly({
      target: shallowRef<CspHintTarget>(target),
    }))) ?? [];
    // flushPromises alone does not wait for the optional dynamic module import.
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(messages).toHaveLength(513);
    expect(messages[0]?.value).toMatchObject({ tone: 'caution' });
    expect(messages[511]?.value).toMatchObject({ tone: 'caution' });
    expect(messages[512]?.value).toBeUndefined();
    const { getDevelopmentMetaCspOwnerNotForSecurity } = await import('@/logic/development-meta-csp/owner');
    const native = getDevelopmentMetaCspOwnerNotForSecurity();
    for (const offset of [0, 33]) {
      const serialized = Array.from({ length: offset === 0 ? 33 : 32 }, (_, index) => `connect-src https://host-${offset + index}.example`).join(', ');
      await native.addForDevelopmentNotForSecurity({ serialized, source: 'developer-action', isCurrent: () => true, isRecoveryResident: () => true });
    }
    expect(messages.every(message => message.value === undefined)).toBe(true);
    expect(core.getCspDeveloperSnapshotForDisplayOnly().addedMetaParsed).toBeUndefined();
  });
});
