import type { Component } from 'vue';

export type StartupState =
  | {
    kind: 'initializing',
  }
  | {
    kind: 'waiting-for-onboarding',
    mainLayout:
      | 'preview-not-rendered'
      | 'preview-rendered',
  }
  | {
    kind: 'starting-main',
    mainLayout:
      | 'preview-not-rendered'
      | 'preview-rendered',
  }
  | {
    kind: 'ready',
    mainApplication: Component,
  }
  | {
    kind: 'error',
    error: unknown,
  };
