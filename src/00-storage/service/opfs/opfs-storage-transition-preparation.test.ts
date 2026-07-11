import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  notifyRegisteredOpfsExternalTransitionSettled,
  notifyRegisteredOpfsExternalTransitionStarting,
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
      externalTransitionStarting: async () => {},
      prepare: async () => {
        events.push('started');
        await first.promise;
        events.push('finished');
      },
      externalTransitionSettled: () => {},
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
      externalTransitionStarting: async () => {},
      prepare,
      externalTransitionSettled: () => {},
    });
    unregister();

    await prepareRegisteredOpfsStorageTransition();

    expect(prepare).not.toHaveBeenCalled();
  });

  it('notifies application presentation before external preparation', async () => {
    const externalTransitionStarting = vi.fn(async () => {});
    registerOpfsStorageTransitionPreparation({
      externalTransitionStarting,
      prepare: async () => {},
      externalTransitionSettled: () => {},
    });

    await notifyRegisteredOpfsExternalTransitionStarting();

    expect(externalTransitionStarting).toHaveBeenCalledOnce();
  });

  it('reports the external settlement to application presentation', () => {
    const externalTransitionSettled = vi.fn();
    registerOpfsStorageTransitionPreparation({
      externalTransitionStarting: async () => {},
      prepare: async () => {},
      externalTransitionSettled,
    });

    notifyRegisteredOpfsExternalTransitionSettled({ settlement: 'completed' });

    expect(externalTransitionSettled).toHaveBeenCalledWith({
      settlement: 'completed',
    });
  });
});
