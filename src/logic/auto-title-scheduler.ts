import type { ChatId } from '@/01-models/ids';

type TitleJob = {
  chatId: ChatId,
  run: ({ signal }: { signal: AbortSignal }) => Promise<void>,
};

/** Automatic titles may use idle time, but never own a foreground operation. */
export function createAutoTitleScheduler({ quietMs, now, onError }: {
  quietMs: number,
  now: () => number,
  onError: ({ error }: { error: unknown }) => void,
}) {
  const pending = new Map<ChatId, TitleJob>();
  const holds = new Set<symbol>();
  let active: { job: TitleJob, controller: AbortController } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let foreground: 'busy' | 'idle' = 'idle';
  let quietUntil = 0;

  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function arm(): void {
    clearTimer();
    if (foreground === 'busy' || holds.size !== 0 || active !== undefined || pending.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (now() < quietUntil) {
        arm();
        return;
      }
      // The most recently completed conversation is the most relevant one.
      const job = Array.from(pending.values()).at(-1);
      if (job === undefined) return;
      pending.delete(job.chatId);
      const entry = { job, controller: new AbortController() };
      active = entry;
      void (async () => {
        try {
          await job.run({ signal: entry.controller.signal });
        } catch (error) {
          if (!entry.controller.signal.aborted) {
            try {
              onError({ error });
            } catch { /* Diagnostics must not reject unobserved background work. */ }
          }
        } finally {
          // Keep ownership until cleanup settles, even if abort is ignored.
          // Foreground callers never await this promise.
          if (active === entry) active = undefined;
          quietUntil = Math.max(quietUntil, now() + quietMs);
          arm();
        }
      })();
    }, Math.max(0, quietUntil - now()));
  }

  function noteActivity(): void {
    quietUntil = now() + quietMs;
    if (active !== undefined && !active.controller.signal.aborted) {
      // A newer completion for this chat wins over an interrupted old job.
      if (!pending.has(active.job.chatId)) pending.set(active.job.chatId, active.job);
      active.controller.abort();
    }
    arm();
  }

  function cancel({ chatId }: { chatId: ChatId }): void {
    pending.delete(chatId);
    if (active?.job.chatId === chatId) active.controller.abort();
    arm();
  }

  return {
    schedule({ chatId, run }: { chatId: TitleJob['chatId'], run: TitleJob['run'] }): void {
      cancel({ chatId });
      pending.set(chatId, { chatId, run });
      quietUntil = now() + quietMs;
      arm();
    },
    noteActivity,
    setForeground({ state }: { state: 'busy' | 'idle' }): void {
      if (foreground === state) return;
      foreground = state;
      noteActivity();
    },
    /** Composition, explicit title requests, and other sustained user work. */
    hold(): () => void {
      const token = Symbol();
      holds.add(token);
      noteActivity();
      return () => {
        if (holds.delete(token)) noteActivity();
      };
    },
    cancel,
    reset(): void {
      pending.clear();
      active?.controller.abort();
      clearTimer();
      quietUntil = now() + quietMs;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
