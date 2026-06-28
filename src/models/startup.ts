import type { Component } from 'vue';

export type StartupState =
  | {
    kind: 'initializing-foundation',
  }
  | {
    kind: 'starting-main',
  }
  | {
    kind: 'rendering-main',
    mainApp: Component,
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
