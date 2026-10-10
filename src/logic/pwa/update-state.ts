export type PWAUpdateState =
  | { kind: 'idle' }
  | { kind: 'preparing'; handler?: () => Promise<void> }
  | { kind: 'ready'; handler: () => Promise<void> };

export const TEST_ONLY = {
};
