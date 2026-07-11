import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareRegisteredOpfsStorageTransition,
  registerOpfsStorageTransitionPreparation,
  TEST_ONLY,
} from './opfs-storage-transition-preparation';

afterEach(() => {
  TEST_ONLY.preparations.clear();
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
    const unregister = registerOpfsStorageTransitionPreparation({ prepare });
    unregister();

    await prepareRegisteredOpfsStorageTransition();

    expect(prepare).not.toHaveBeenCalled();
  });
});
