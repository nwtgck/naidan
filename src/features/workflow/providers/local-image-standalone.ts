import type { createWorkflowImageProvider as HostedFactory } from './local-image';

/** Editing and history remain available without loading local inventory or engines. */
export const createWorkflowImageProvider: typeof HostedFactory = () => ({
  async generate() {
    throw new Error('Local image inference is not included in this build.');
  },
  close() {},
});

export const TEST_ONLY = {
};
