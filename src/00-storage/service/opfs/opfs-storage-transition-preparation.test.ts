import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  notifyRegisteredOpfsExternalTransitionPrepared,
  prepareRegisteredOpfsStorageTransition,
  registerOpfsStorageTransitionPreparation,
  TEST_ONLY,
} from './opfs-storage-transition-preparation';

afterEach(() => {
  TEST_ONLY.registrations.clear();
  vi.restoreAllMocks();
});

describe('OPFS storage transition preparation registry', () => {
  it('awaits registered application cleanup before returning', async () => {
    const events: string[] = [];
    const first = Promise.withResolvers<void>();
    registerOpfsStorageTransitionPreparation({
      prepare: async () => {
        events.push('started');
        await first.promise;
        events.push('finished');
      },
      externalTransitionPrepared: () => {},
    });

    const preparation = prepareRegisteredOpfsStorageTransition();
    await Promise.resolve();
    expect(events).toEqual(['started']);

    first.resolve();
    await preparation;
    expect(events).toEqual(['started', 'finished']);
  });

  it('does not call an unregistered preparation', async () => {
    const prepare = vi.fn(async () => {});
    const unregister = registerOpfsStorageTransitionPreparation({
      prepare,
      externalTransitionPrepared: () => {},
    });
    unregister();

    await prepareRegisteredOpfsStorageTransition();

    expect(prepare).not.toHaveBeenCalled();
  });

  it('notifies registered application code after external preparation', () => {
    const externalTransitionPrepared = vi.fn();
    registerOpfsStorageTransitionPreparation({
      prepare: async () => {},
      externalTransitionPrepared,
    });

    notifyRegisteredOpfsExternalTransitionPrepared();

    expect(externalTransitionPrepared).toHaveBeenCalledOnce();
  });
});
