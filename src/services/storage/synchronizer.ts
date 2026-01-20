import { z } from 'zod';
import { SYNC_SIGNAL_KEY } from '../../models/constants';

export const StorageChangeEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('chat_meta_and_chat_group'),
    id: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('chat_content'),
    id: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('chat_content_generation'),
    id: z.string(),
    status: z.enum(['started', 'stopped', 'abort_request']),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('settings'),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('migration'),
    timestamp: z.number(),
  }),
]);

export type StorageChangeEvent = z.infer<typeof StorageChangeEventSchema>;
export type ChangeType = StorageChangeEvent['type'];

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
            const raw = JSON.parse(e.newValue);
            const result = StorageChangeEventSchema.safeParse(raw);
            if (result.success) {
              this.emit(result.data);
            } else {
              console.warn('Failed to validate storage signal:', result.error);
            }
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
            const result = StorageChangeEventSchema.safeParse(ev.data);
            if (result.success) {
              this.emit(result.data);
            } else {
              console.warn('Failed to validate broadcast message:', result.error);
            }
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
      lockKey,
      notifyLockWaitAfterMs = 3000, 
      notifyTaskSlowAfterMs = 5000,
      onLockWait,
      onTaskSlow,
      onFinalize
    }: { 
      lockKey: string;
      notifyLockWaitAfterMs?: number;
      notifyTaskSlowAfterMs?: number;
      onLockWait?: () => void;
      onTaskSlow?: () => void;
      onFinalize?: () => void;
    }
  ): Promise<T> {
    let wasSlow = false;

    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      // 1. Monitor Lock Acquisition
      const lockTimer = setTimeout(() => {
        wasSlow = true;
        onLockWait?.();
      }, notifyLockWaitAfterMs);

      try {
        return await navigator.locks.request(lockKey, async () => {
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
  notify(event: StorageChangeEvent): void;
  /**
   * @deprecated Use notify(event: StorageChangeEvent) instead.
   */
  notify(type: string, id?: string): void;
  notify(eventOrType: StorageChangeEvent | string, id?: string): void {
    let event: StorageChangeEvent;
    if (typeof eventOrType === 'string') {
      event = {
        type: eventOrType,
        id,
        timestamp: Date.now(),
      } as unknown as StorageChangeEvent;
    } else {
      event = eventOrType;
    }

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
