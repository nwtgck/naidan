import { defineComponent, shallowRef } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import type { OpfsEncryptionStartupGate } from './opfs-encryption-startup-gate';
import { resolveStartupFailureState } from './startup-failure-state';

function createGate({
  phase,
}: {
  phase: OpfsEncryptionStartupGate['phase']['value'],
}): OpfsEncryptionStartupGate {
  return {
    inspection: shallowRef({
      type: 'recovery_required',
      error: new Error('test inspection'),
    }),
    phase: shallowRef(phase),
    applicationError: shallowRef(undefined),
    progress: shallowRef(undefined),
    unlockWithPassphrase: vi.fn(async () => {}),
    returnInterruptedEncryptionToPlain: vi.fn(async () => {}),
    retryInspection: vi.fn(async () => {}),
    reportApplicationFailure: vi.fn(),
    reportUnlockPresentationReady: vi.fn(),
    wait: vi.fn(async () => {}),
    waitForUnlockPresentation: vi.fn(async () => {}),
  };
}

const MainApp = defineComponent({
  template: '<div />',
});

describe('resolveStartupFailureState', () => {
  it('keeps the lock presentation when settings fail immediately after unlock', () => {
    const gate = createGate({ phase: 'preparing_application' });
    const error = new Error('failed to load encrypted settings');

    const result = resolveStartupFailureState({
      state: {
        kind: 'opfs-encryption-required',
        gate,
      },
      error,
    });

    expect(result).toEqual({
      kind: 'opfs-encryption-main-failed',
      gate,
      error,
      mainApp: undefined,
    });
    expect(gate.reportApplicationFailure).toHaveBeenCalledWith({ error });
  });

  it('keeps the already mounted main app behind the lock after a late failure', () => {
    const gate = createGate({ phase: 'preparing_application' });
    const error = new Error('route failed to render');

    const result = resolveStartupFailureState({
      state: {
        kind: 'rendering-main-after-opfs-unlock',
        gate,
        mainApp: MainApp,
        renderGate: {
          reportInitialRender: () => {},
          reportInitialRenderFailure: () => {},
          waitForInitialRender: async () => {},
        },
      },
      error,
    });

    expect(result).toEqual({
      kind: 'opfs-encryption-main-failed',
      gate,
      error,
      mainApp: MainApp,
    });
    expect(gate.reportApplicationFailure).toHaveBeenCalledWith({ error });
  });

  it('uses the normal foundation failure before an encrypted store is unlocked', () => {
    const gate = createGate({ phase: 'locked' });
    const error = new Error('startup failed before unlock');

    const result = resolveStartupFailureState({
      state: {
        kind: 'opfs-encryption-required',
        gate,
      },
      error,
    });

    expect(result).toEqual({
      kind: 'foundation-failed',
      error,
    });
    expect(gate.reportApplicationFailure).not.toHaveBeenCalled();
  });
});
