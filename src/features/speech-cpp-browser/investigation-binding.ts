import type { SpeechInvestigationBinding, SpeechInvestigationContext } from './worker/investigation-context';
import type { SpeechInvestigationWireObserver } from './worker/investigation-protocol';

export type SpeechInvestigationLease = { context: SpeechInvestigationContext, release(): void };

/** App-local callbacks never enter IPC. A replaced operation's cleanup cannot
 * remove a newer binding, even when a load and its first run share an ID. */
export function createSpeechInvestigationBindings() {
  let entries: Map<string, SpeechInvestigationBinding> | undefined;
  const receive: SpeechInvestigationWireObserver = ({ context, event }) => {
    const binding = entries?.get(context.operationId);
    if (binding?.context.source === context.source) {
      try {
        binding.observer({ event });
      } catch { /* Observational only. */ }
    }
  };
  return {
    receive,
    bind({ binding }: { binding: SpeechInvestigationBinding | undefined }): SpeechInvestigationLease | undefined {
      if (binding === undefined) {
        return undefined;
      }
      const entry = { ...binding };
      entries ??= new Map();
      entries.set(entry.context.operationId, entry);
      return {
        context: entry.context,
        release() {
          if (entries?.get(entry.context.operationId) === entry) {
            entries.delete(entry.context.operationId);
            if (entries.size === 0) {
              entries = undefined;
            }
          }
        },
      };
    },
    clear(): void {
      entries = undefined;
    },
  };
}

export const TEST_ONLY = {
};
