import { SYNC_SIGNAL_KEY, SYNC_LOCK_KEY } from '../../models/constants';

type ChangeType = 'chat' | 'chat_group' | 'settings' | 'sidebar' | 'migration';

export interface StorageChangeEvent {
  type: ChangeType;
  id?: string;
  timestamp: number;
}

export type ChangeListener = (event: StorageChangeEvent) => void;

export class StorageSynchronizer {
  private listeners: Set<ChangeListener> = new Set();
  private broadcastChannel: BroadcastChannel | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      // 1. LocalStorage Signal (Primary mechanism for file:// compatibility)
      window.addEventListener('storage', (e) => {
        if (e.key === SYNC_SIGNAL_KEY && e.newValue) {
          try {
            const event = JSON.parse(e.newValue) as StorageChangeEvent;
            this.emit(event);
          } catch (err) {
            console.error('Failed to parse storage signal:', err);
          }
        }
      });

      // 2. BroadcastChannel (Optimization)
      if (typeof BroadcastChannel !== 'undefined') {
        try {
          this.broadcastChannel = new BroadcastChannel('naidan_storage_sync');
          this.broadcastChannel.onmessage = (ev) => {
            this.emit(ev.data as StorageChangeEvent);
          };
        } catch (e) {
          // Ignore errors in strict environments
        }
      }
    }
  }

  /**
   * Executes a function with an exclusive lock.
   * Uses navigator.locks (Web Locks API).
   * 
   * This version does not force a failure but monitors the time taken.
   * It provides callbacks to notify if lock acquisition or task execution is taking too long.
   */
  async withLock<T>(
    fn: () => Promise<T>, 
    { 
      notifyLockWaitAfterMs = 3000, 
      notifyTaskSlowAfterMs = 5000,
      onLockWait,
      onTaskSlow,
      onFinalize
    }: { 
      notifyLockWaitAfterMs?: number;
      notifyTaskSlowAfterMs?: number;
      onLockWait?: () => void;
      onTaskSlow?: () => void;
      onFinalize?: () => void;
    } = {}
  ): Promise<T> {
    let wasSlow = false;

    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      // 1. Monitor Lock Acquisition
      const lockTimer = setTimeout(() => {
        wasSlow = true;
        onLockWait?.();
      }, notifyLockWaitAfterMs);

      try {
        return await navigator.locks.request(SYNC_LOCK_KEY, async () => {
          clearTimeout(lockTimer);

          // 2. Monitor Task Execution
          const taskTimer = setTimeout(() => {
            wasSlow = true;
            onTaskSlow?.();
          }, notifyTaskSlowAfterMs);

          try {
            return await fn();
          } finally {
            clearTimeout(taskTimer);
          }
        });
      } finally {
        clearTimeout(lockTimer);
        if (wasSlow) {
          onFinalize?.();
        }
      }
    } else {
      // Fallback for environments without Web Locks
      return await fn();
    }
  }

  /**
   * Notifies other tabs of a change.
   */
  notify(type: ChangeType, id?: string) {
    const event: StorageChangeEvent = {
      type,
      id,
      timestamp: Date.now(),
    };

    // 1. LocalStorage Signal
    try {
      localStorage.setItem(SYNC_SIGNAL_KEY, JSON.stringify(event));
    } catch (e) {
      console.warn('Failed to signal via localStorage:', e);
    }

    // 2. BroadcastChannel Signal
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage(event);
      } catch (e) {
        // ignore
      }
    }
  }

  subscribe(listener: ChangeListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: StorageChangeEvent) {
    this.listeners.forEach(l => l(event));
  }
}
