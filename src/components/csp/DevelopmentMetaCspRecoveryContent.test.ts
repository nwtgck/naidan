import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick, shallowRef, type ShallowRef } from 'vue';
import type { DevelopmentMetaCspSnapshotNotForSecurity } from '@/logic/development-meta-csp/types';
import DevelopmentMetaCspRecoveryContent from './DevelopmentMetaCspRecoveryContent.vue';

const useDevelopment = vi.hoisted(() => vi.fn());
const strings = vi.hoisted(() => ({ pending: Promise.resolve(), failed: false, title: 'Development CSP', loads: 0 }));
vi.mock('@/composables/useDevelopmentMetaCspNotForSecurity', () => ({ useDevelopmentMetaCspNotForSecurity: useDevelopment }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ initialized }) }));
vi.mock('@/strings', () => ({
  ensureStrings: {
    DevelopmentMetaCspRecovery__development_meta_csp: async () => {
      strings.loads++;
      await strings.pending;
      if (strings.failed) {
        throw new Error('Optional recovery strings failed');
      }
      return strings.title;
    },
    DevelopmentMetaCspRecovery__development_only_never_for_security: async () => 'Not for security use',
    DevelopmentMetaCspRecovery__close_notice: async () => 'Close notice',
    DevelopmentMetaCspRecovery__clear_saved_meta_csp_setting: async () => 'Clear saved setting',
    DevelopmentMetaCspRecovery__clearing_saved_meta_csp: async () => 'Clearing saved meta CSP…',
    DevelopmentMetaCspRecovery__could_not_clear_saved_setting: async () => 'Could not clear the saved setting. Try again.',
    DevelopmentMetaCspRecovery__storage_changed_try_again: async () => 'The storage changed. Try again.',
    DevelopmentMetaCspRecovery__setting_cleared_current_meta_remains: async () => 'Setting cleared; current meta remains active.',
  },
}));

let initialized: ShallowRef<boolean>;
let snapshot: ShallowRef<DevelopmentMetaCspSnapshotNotForSecurity>;
let savedSerialized: ShallowRef<string | undefined>;
let operation: ShallowRef<'idle' | 'saving' | 'failed' | 'changed' | 'saved'>;
let prepare: ReturnType<typeof vi.fn<({ isRecoveryResident }: { isRecoveryResident(): boolean }) => Promise<void>>>;
let clear: ReturnType<typeof vi.fn<() => Promise<'saved' | 'changed' | 'failed' | 'busy'>>>;

beforeEach(() => {
  strings.pending = Promise.resolve();
  strings.failed = false;
  strings.title = 'Development CSP';
  strings.loads = 0;
  initialized = shallowRef(true);
  snapshot = shallowRef<DevelopmentMetaCspSnapshotNotForSecurity>({ preparation: 'idle', reason: undefined, installation: { kind: 'not-added' }, additions: [], diagnostics: 'complete', privacyBroker: { kind: 'not-created', sessionId: undefined, syncId: undefined, requestedPolicyCount: 0, confirmedPolicyCount: 0, reason: undefined } });
  savedSerialized = shallowRef<string>();
  operation = shallowRef<'idle' | 'saving' | 'failed' | 'changed' | 'saved'>('idle');
  prepare = vi.fn(async () => undefined);
  clear = vi.fn(async () => 'saved' as const);
  useDevelopment.mockReturnValue({
    snapshot,
    savedSerialized,
    operation,
    captureStorageForDevelopmentMetaCspNotForSecurity: () => () => true,
    prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity: prepare,
    saveDevelopmentMetaCspNotForSecurity: vi.fn(),
    clearDevelopmentMetaCspNotForSecurity: clear,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resident development meta CSP recovery', () => {
  it('dismisses only the notice and retains the prepared controls and saved policy', async () => {
    savedSerialized.value = "connect-src 'self';";
    snapshot.value = { ...snapshot.value, additions: [{ serialized: savedSerialized.value, policies: [savedSerialized.value], source: 'saved-setting' }] };
    using mounted = {
      wrapper: mount(DevelopmentMetaCspRecoveryContent, { attachTo: document.body }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await flushPromises();
    const guard = prepare.mock.calls[0]?.[0].isRecoveryResident;
    const original = mounted.wrapper.get('[data-testid="development-meta-csp-clear"]').element;
    const additions = snapshot.value.additions;
    expect(mounted.wrapper.get('[data-testid="development-meta-csp-dismiss"]').attributes('aria-label')).toBe('Close notice');
    await mounted.wrapper.get('[data-testid="development-meta-csp-dismiss"]').trigger('click');
    expect(mounted.wrapper.get('[data-testid="development-meta-csp-recovery"]').isVisible()).toBe(false);
    expect(savedSerialized.value).toBe("connect-src 'self';");
    expect(snapshot.value.additions).toBe(additions);
    expect(clear).not.toHaveBeenCalled();
    expect(mounted.wrapper.get('[data-testid="development-meta-csp-clear"]').element).toBe(original);
    expect(original.isConnected).toBe(true);
    expect(guard?.()).toBe(true);
    expect(strings.loads).toBe(1);
  });

  it('shows a dismissed notice again when a different saved policy needs attention', async () => {
    savedSerialized.value = "connect-src 'self';";
    using mounted = {
      wrapper: mount(DevelopmentMetaCspRecoveryContent, { attachTo: document.body }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await flushPromises();
    const original = mounted.wrapper.get('[data-testid="development-meta-csp-clear"]').element;
    await mounted.wrapper.get('[data-testid="development-meta-csp-dismiss"]').trigger('click');
    expect(mounted.wrapper.get('[data-testid="development-meta-csp-recovery"]').isVisible()).toBe(false);
    savedSerialized.value = "connect-src 'none';";
    await nextTick();
    expect(mounted.wrapper.get('[data-testid="development-meta-csp-recovery"]').isVisible()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="development-meta-csp-clear"]').element).toBe(original);
    expect(clear).not.toHaveBeenCalled();
    expect(strings.loads).toBe(1);
  });

  it('leaves no frame while registering a false predicate before the first saved setting', async () => {
    using mounted = {
      wrapper: mount(DevelopmentMetaCspRecoveryContent, { attachTo: document.body }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await flushPromises();
    expect(mounted.wrapper.find('aside, button').exists()).toBe(false);
    expect(prepare).toHaveBeenCalledOnce();
    const resident = prepare.mock.calls[0]?.[0].isRecoveryResident;
    expect(resident?.()).toBe(false);
    savedSerialized.value = "connect-src 'self';";
    await flushPromises();
    expect(mounted.wrapper.get('[data-testid="development-meta-csp-clear"]').element.isConnected).toBe(true);
    expect(resident?.()).toBe(true);
  });

  it('waits for settings, resolved labels, and a connected native clear button before registering strict saved meta', async () => {
    const labels = Promise.withResolvers<void>();
    strings.pending = labels.promise;
    initialized.value = false;
    savedSerialized.value = "default-src 'none'; script-src 'none'; style-src 'none';";
    let unmounted = false;
    using mounted = {
      wrapper: mount(DevelopmentMetaCspRecoveryContent, { attachTo: document.body }),
      [Symbol.dispose]() {
        if (!unmounted) {
          this.wrapper.unmount();
          unmounted = true;
        }
      },
    };
    await nextTick();
    expect(prepare).not.toHaveBeenCalled();
    expect(mounted.wrapper.find('button').exists()).toBe(false);
    labels.resolve();
    await flushPromises();
    expect(mounted.wrapper.get('[data-testid="development-meta-csp-clear"]').element.isConnected).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    initialized.value = true;
    await flushPromises();
    expect(prepare).toHaveBeenCalledOnce();
    const guard = prepare.mock.calls[0]?.[0].isRecoveryResident;
    expect(guard?.()).toBe(true);
    expect(mounted.wrapper.text()).toContain('Not for security use');
    mounted.wrapper.unmount();
    unmounted = true;
    expect(guard?.()).toBe(false);
  });

  it('does not register a disconnected recovery button', async () => {
    savedSerialized.value = "script-src 'none';";
    using mounted = {
      wrapper: mount(DevelopmentMetaCspRecoveryContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await flushPromises();
    expect(mounted.wrapper.find('button').exists()).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('skips registration completely when recovery labels cannot be loaded', async () => {
    strings.failed = true;
    savedSerialized.value = "script-src 'none';";
    using mounted = {
      wrapper: mount(DevelopmentMetaCspRecoveryContent, { attachTo: document.body }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await flushPromises();
    expect(mounted.wrapper.find('aside, button').exists()).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('keeps the same button and resident labels after clearing the saved value while persistence is pending', async () => {
    savedSerialized.value = "script-src 'none'; style-src 'none';";
    snapshot.value = { ...snapshot.value, additions: [{ serialized: savedSerialized.value, policies: [savedSerialized.value], source: 'saved-setting' }] };
    const completion = Promise.withResolvers<'saved'>();
    clear.mockImplementation(() => {
      savedSerialized.value = undefined;
      operation.value = 'saving';
      return completion.promise;
    });
    using mounted = {
      wrapper: mount(DevelopmentMetaCspRecoveryContent, { attachTo: document.body }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await flushPromises();
    const button = mounted.wrapper.get('[data-testid="development-meta-csp-clear"]');
    const original = button.element;
    const guard = prepare.mock.calls[0]?.[0].isRecoveryResident;
    strings.failed = true;
    strings.title = 'A later locale would require a blocked pack';
    await button.trigger('click');
    expect(clear).toHaveBeenCalledOnce();
    expect(savedSerialized.value).toBeUndefined();
    expect(mounted.wrapper.get('[data-testid="development-meta-csp-clear"]').element).toBe(original);
    expect(guard?.()).toBe(true);
    expect(snapshot.value.additions).toHaveLength(1);
    expect(mounted.wrapper.get('[data-testid="development-meta-csp-setting-cleared"]').text()).toContain('current meta remains active');
    expect(mounted.wrapper.text()).toContain('Development CSP');
    expect(mounted.wrapper.text()).not.toContain('blocked pack');
    expect(strings.loads).toBe(1);
    operation.value = 'saved';
    completion.resolve('saved');
    await flushPromises();
    expect(mounted.wrapper.get('[data-testid="development-meta-csp-clear"]').element).toBe(original);
    expect(guard?.()).toBe(true);
  });

  it.each(['failed', 'changed'] as const)('shows a resident %s status and keeps recovery available without preparing new imports', async outcome => {
    savedSerialized.value = "script-src 'none';";
    clear.mockImplementation(async () => {
      operation.value = outcome;
      return outcome;
    });
    using mounted = {
      wrapper: mount(DevelopmentMetaCspRecoveryContent, { attachTo: document.body }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await flushPromises();
    const original = mounted.wrapper.get('[data-testid="development-meta-csp-clear"]').element;
    strings.failed = true;
    await mounted.wrapper.get('[data-testid="development-meta-csp-clear"]').trigger('click');
    await flushPromises();
    expect(mounted.wrapper.get('[role="status"]').text()).toContain('Try again');
    expect(mounted.wrapper.get('[data-testid="development-meta-csp-clear"]').element).toBe(original);
    expect(mounted.wrapper.get('[data-testid="development-meta-csp-clear"]').attributes('disabled')).toBeUndefined();
    expect(strings.loads).toBe(1);
  });
});
