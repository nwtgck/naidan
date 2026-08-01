import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  notifyRegisteredOpfsExternalTransitionSettled,
  notifyRegisteredOpfsLocalTransitionSettled,
  notifyRegisteredOpfsLocalTransitionStarting,
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
      localTransitionStarting: () => {},
      externalTransitionStarting: async () => {},
      prepare: async () => {
        events.push('started');
        await first.promise;
        events.push('finished');
      },
      localTransitionSettled: () => {},
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
      localTransitionStarting: () => {},
      externalTransitionStarting: async () => {},
      prepare,
      localTransitionSettled: () => {},
      externalTransitionSettled: () => {},
    });
    unregister();

    await prepareRegisteredOpfsStorageTransition();

    expect(prepare).not.toHaveBeenCalled();
  });

  it('notifies application presentation before external preparation', async () => {
    const externalTransitionStarting = vi.fn(async () => {});
    registerOpfsStorageTransitionPreparation({
      localTransitionStarting: () => {},
      externalTransitionStarting,
      prepare: async () => {},
      localTransitionSettled: () => {},
      externalTransitionSettled: () => {},
    });

    await notifyRegisteredOpfsExternalTransitionStarting();

    expect(externalTransitionStarting).toHaveBeenCalledOnce();
  });

  it('reports the external settlement to application presentation', () => {
    const externalTransitionSettled = vi.fn();
    registerOpfsStorageTransitionPreparation({
      localTransitionStarting: () => {},
      externalTransitionStarting: async () => {},
      prepare: async () => {},
      localTransitionSettled: () => {},
      externalTransitionSettled,
    });

    notifyRegisteredOpfsExternalTransitionSettled({ settlement: 'completed' });

    expect(externalTransitionSettled).toHaveBeenCalledWith({
      settlement: 'completed',
    });
  });

  it('reports local start and settlement to the initiating application tab', () => {
    const localTransitionStarting = vi.fn();
    const localTransitionSettled = vi.fn();
    registerOpfsStorageTransitionPreparation({
      localTransitionStarting,
      externalTransitionStarting: async () => {},
      prepare: async () => {},
      localTransitionSettled,
      externalTransitionSettled: () => {},
    });

    notifyRegisteredOpfsLocalTransitionStarting();
    notifyRegisteredOpfsLocalTransitionSettled({ settlement: 'failed' });

    expect(localTransitionStarting).toHaveBeenCalledOnce();
    expect(localTransitionSettled).toHaveBeenCalledWith({ settlement: 'failed' });
  });

});
