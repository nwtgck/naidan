import { describe, expect, it, vi } from 'vitest';
import { createOpfsTransitionReloadGuard } from './opfs-transition-reload-guard';

function createEventTargetHarness(): {
  readonly addEventListener: (type: string, listener: EventListener) => void;
  readonly dispatch: ({ type }: { type: string }) => void;
  readonly removeEventListener: (type: string, listener: EventListener) => void;
  } {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener(type, listener) {
      const current = listeners.get(type) ?? new Set<EventListener>();
      current.add(listener);
      listeners.set(type, current);
    },
    dispatch({ type }) {
      for (const listener of listeners.get(type) ?? []) {
        listener(new Event(type));
      }
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
}

describe('createOpfsTransitionReloadGuard', () => {
  it('reloads the initiating or follower tab once after settlement', () => {
    const documentEvents = createEventTargetHarness();
    const windowEvents = createEventTargetHarness();
    const reload = vi.fn();
    const guard = createOpfsTransitionReloadGuard({
      document: {
        ...documentEvents,
        visibilityState: 'visible',
      } as unknown as Document,
      window: {
        ...windowEvents,
        location: { reload },
      } as unknown as Window,
    });

    guard.markTransitionStarted();
    guard.reloadAfterSettlement();
    guard.reloadAfterSettlement();

    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads a pending frozen tab before it can resume normal operation', () => {
    const documentEvents = createEventTargetHarness();
    const windowEvents = createEventTargetHarness();
    const reload = vi.fn();
    const guard = createOpfsTransitionReloadGuard({
      document: {
        ...documentEvents,
        visibilityState: 'visible',
      } as unknown as Document,
      window: {
        ...windowEvents,
        location: { reload },
      } as unknown as Window,
    });

    guard.markTransitionStarted();
    windowEvents.dispatch({ type: 'pageshow' });
    documentEvents.dispatch({ type: 'visibilitychange' });

    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not reload on lifecycle events before a transition is observed', () => {
    const documentEvents = createEventTargetHarness();
    const windowEvents = createEventTargetHarness();
    const reload = vi.fn();
    const guard = createOpfsTransitionReloadGuard({
      document: {
        ...documentEvents,
        visibilityState: 'visible',
      } as unknown as Document,
      window: {
        ...windowEvents,
        location: { reload },
      } as unknown as Window,
    });

    windowEvents.dispatch({ type: 'pageshow' });
    documentEvents.dispatch({ type: 'visibilitychange' });

    expect(reload).not.toHaveBeenCalled();
    guard.dispose();
  });
});
