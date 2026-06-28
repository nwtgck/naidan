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
    mainApplication: Component,
  }
  | {
    kind: 'ready',
    mainApplication: Component,
  }
  | {
    kind: 'foundation-failed',
    error: unknown,
  }
  | {
    kind: 'main-failed',
    error: unknown,
  };
