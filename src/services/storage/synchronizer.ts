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
   */
  async withLock<T>(
    fn: () => Promise<T>, 
    { timeoutMs = 10000 }: { timeoutMs?: number } = {}
  ): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        return await navigator.locks.request(SYNC_LOCK_KEY, { signal: controller.signal }, async () => {
          clearTimeout(timer);
          return await fn();
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error(`Lock acquisition timed out after ${timeoutMs}ms. Another tab might be performing a long operation.`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    } else {
      // Fallback for environments without Web Locks (should be rare in modern browsers)
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
