import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageSynchronizer } from './synchronizer';
import { SYNC_SIGNAL_KEY, SYNC_LOCK_KEY } from '../../models/constants';

describe('StorageSynchronizer', () => {
  let synchronizer: StorageSynchronizer;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    synchronizer = new StorageSynchronizer();
  });

  describe('withLock', () => {
    it('should execute the provided function and return its result', async () => {
      const task = async () => 'result';
      const result = await synchronizer.withLock(task, { lockKey: SYNC_LOCK_KEY });
      expect(result).toBe('result');
    });

    it('should handle errors in the provided function', async () => {
      const task = async () => {
        throw new Error('Task failed');
      };
      await expect(synchronizer.withLock(task, { lockKey: SYNC_LOCK_KEY })).rejects.toThrow('Task failed');
    });

    it('should use navigator.locks if available', async () => {
      const mockRequest = vi.fn((...args) => {
        const callback = args[args.length - 1];
        return callback();
      });
      const originalLocks = navigator.locks;
      
      // Mock navigator.locks
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: { request: mockRequest }
      });

      const task = async () => 'done';
      await synchronizer.withLock(task, { lockKey: SYNC_LOCK_KEY });

      expect(mockRequest).toHaveBeenCalledWith(SYNC_LOCK_KEY, expect.any(Function));

      // Restore
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks
      });
    });

    it('should fallback gracefully if navigator.locks is unavailable', async () => {
      const originalLocks = navigator.locks;
      
      // Remove navigator.locks
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: undefined
      });

      const task = async () => 'fallback';
      const result = await synchronizer.withLock(task, { lockKey: SYNC_LOCK_KEY });
      expect(result).toBe('fallback');

      // Restore
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks
      });
    });

    it('should trigger onLockWait if lock acquisition is delayed', async () => {
      vi.useFakeTimers();
      
      // Mock request that never resolves
      const mockRequest = vi.fn(() => new Promise(() => {}));
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: { request: mockRequest }
      });

      const onLockWait = vi.fn();
      synchronizer.withLock(async () => {}, { lockKey: SYNC_LOCK_KEY, onLockWait, notifyLockWaitAfterMs: 100 });

      await vi.advanceTimersByTimeAsync(150);
      expect(onLockWait).toHaveBeenCalled();
      
      vi.useRealTimers();
    });

    it('should trigger onTaskSlow if task execution is delayed', async () => {
      vi.useFakeTimers();
      
      // Mock request that executes task
      const mockRequest = vi.fn((_name, cb) => cb());
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: { request: mockRequest }
      });

      const onTaskSlow = vi.fn();
      const task = () => new Promise((resolve) => setTimeout(resolve, 1000));
      
      synchronizer.withLock(task, { lockKey: SYNC_LOCK_KEY, onTaskSlow, notifyTaskSlowAfterMs: 500 });

      await vi.advanceTimersByTimeAsync(600);
      expect(onTaskSlow).toHaveBeenCalled();
      
      vi.useRealTimers();
    });

    it('should trigger onFinalize if any delay occurred', async () => {
      vi.useFakeTimers();
      
      const mockRequest = vi.fn((_name, cb) => cb());
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: { request: mockRequest }
      });

      const onFinalize = vi.fn();
      const task = () => new Promise((resolve) => setTimeout(resolve, 1000));
      
      const promise = synchronizer.withLock(task, { lockKey: SYNC_LOCK_KEY, onFinalize, notifyTaskSlowAfterMs: 500 });

      await vi.advanceTimersByTimeAsync(600);
      await vi.advanceTimersByTimeAsync(500); // Complete task
      await promise;

      expect(onFinalize).toHaveBeenCalled();
      
      vi.useRealTimers();
    });
  });

  describe('Signaling', () => {
    it('should notify via localStorage', () => {
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
      synchronizer.notify('chat', '123');

      expect(setItemSpy).toHaveBeenCalledWith(
        SYNC_SIGNAL_KEY,
        expect.stringContaining('"type":"chat"')
      );
      expect(setItemSpy).toHaveBeenCalledWith(
        SYNC_SIGNAL_KEY,
        expect.stringContaining('"id":"123"')
      );
    });

    it('should trigger local listeners when a storage event occurs from another tab', () => {
      const listener = vi.fn();
      synchronizer.subscribe(listener);

      const eventData = { type: 'chat', id: '456', timestamp: Date.now() };
      
      // Simulate storage event from another window
      const storageEvent = new StorageEvent('storage', {
        key: SYNC_SIGNAL_KEY,
        newValue: JSON.stringify(eventData)
      });
      window.dispatchEvent(storageEvent);

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        type: 'chat',
        id: '456'
      }));
    });

    it('should notify multiple subscribers', () => {
      const l1 = vi.fn();
      const l2 = vi.fn();
      synchronizer.subscribe(l1);
      synchronizer.subscribe(l2);

      const eventData = { type: 'chat', timestamp: Date.now() };
      const storageEvent = new StorageEvent('storage', {
        key: SYNC_SIGNAL_KEY,
        newValue: JSON.stringify(eventData)
      });
      window.dispatchEvent(storageEvent);

      expect(l1).toHaveBeenCalled();
      expect(l2).toHaveBeenCalled();
    });

    it('should stop notifying after unsubscription', () => {
      const listener = vi.fn();
      const unsubscribe = synchronizer.subscribe(listener);

      unsubscribe();

      const storageEvent = new StorageEvent('storage', {
        key: SYNC_SIGNAL_KEY,
        newValue: JSON.stringify({ type: 'settings' })
      });
      window.dispatchEvent(storageEvent);

      expect(listener).not.toHaveBeenCalled();
    });

    it('should handle malformed JSON in localStorage gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const listener = vi.fn();
      synchronizer.subscribe(listener);

      const storageEvent = new StorageEvent('storage', {
        key: SYNC_SIGNAL_KEY,
        newValue: '{ invalid json'
      });
      window.dispatchEvent(storageEvent);

      expect(consoleSpy).toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should ignore storage events for unrelated keys', () => {
      const listener = vi.fn();
      synchronizer.subscribe(listener);

      const storageEvent = new StorageEvent('storage', {
        key: 'unrelated-key',
        newValue: JSON.stringify({ type: 'chat' })
      });
      window.dispatchEvent(storageEvent);

      expect(listener).not.toHaveBeenCalled();
    });

    it('should trigger local listeners when a BroadcastChannel message arrives', async () => {
      const listener = vi.fn();
      const eventData = { type: 'settings' as const, timestamp: Date.now() };
      
      const originalBC = global.BroadcastChannel;
      
      let capturedHandler: any;
      
      // Mock class
      global.BroadcastChannel = class {
        postMessage = vi.fn();
        close = vi.fn();
        set onmessage(handler: any) {
          capturedHandler = handler;
        }
        get onmessage() {
          return capturedHandler;
        }
      } as any;

      const syncWithMock = new StorageSynchronizer();
      syncWithMock.subscribe(listener);
      
      if (capturedHandler) {
        capturedHandler({ data: eventData });
      }

      expect(listener).toHaveBeenCalledWith(eventData);

      global.BroadcastChannel = originalBC;
    });
  });
});
