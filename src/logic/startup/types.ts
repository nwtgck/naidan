import type { Component } from 'vue';
import type { ApplicationShellRenderGate } from './application-shell-render-gate';
import type { OpfsEncryptionStartupGate } from './opfs-encryption-startup-gate';

export type StartupState =
  | {
    kind: 'initializing-foundation',
  }
  | {
    kind: 'opfs-encryption-required',
    gate: OpfsEncryptionStartupGate,
  }
  | {
    kind: 'starting-main-after-opfs-unlock',
    gate: OpfsEncryptionStartupGate,
  }
  | {
    kind: 'starting-main',
  }
  | {
    kind: 'rendering-main-after-opfs-unlock',
    gate: OpfsEncryptionStartupGate,
    mainApp: Component,
    renderGate: ApplicationShellRenderGate,
  }
  | {
    kind: 'rendering-main',
    mainApp: Component,
  }
  | {
    kind: 'opfs-encryption-main-failed',
    gate: OpfsEncryptionStartupGate,
    error: unknown,
    mainApp: Component | undefined,
  }
  | {
    kind: 'ready',
    mainApp: Component,
  }
  | {
    kind: 'foundation-failed',
    error: unknown,
  }
  | {
    kind: 'main-failed',
    error: unknown,
  };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
