import { generateId } from '@/01-models/id';
import type { GlobalEventId } from '@/01-models/ids';
import { ref, computed, type ComputedRef } from 'vue';

export type EventType = 'info' | 'warn' | 'error' | 'debug';

export type ErrorDetailValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Error
  | Record<string, unknown>
  | unknown[];

export interface GlobalEvent {
  id: GlobalEventId,
  type: EventType,
  timestamp: number,
  message: string,
  details?: ErrorDetailValue,
  source: string,
}

interface GlobalEventsApi {
  events: ComputedRef<GlobalEvent[]>,
  eventCount: ComputedRef<number>,
  errorCount: ComputedRef<number>,
  addEvent: ({
    type,
    source,
    message,
    details,
  }: {
    type: EventType,
    source: string,
    message: string,
    details?: ErrorDetailValue,
  }) => void,
  addErrorEvent: ({
    source,
    message,
    details,
  }: {
    source: string,
    message: string,
    details?: ErrorDetailValue,
  }) => void,
  addInfoEvent: ({
    source,
    message,
    details,
  }: {
    source: string,
    message: string,
    details?: ErrorDetailValue,
  }) => void,
  clearEvents: () => void,
  TEST_ONLY: Record<never, never>,
}

const events = ref<GlobalEvent[]>([]);

export function useGlobalEvents(): GlobalEventsApi {
  const addEvent = ({ type, source, message, details }: { type: EventType, source: string, message: string, details?: ErrorDetailValue }) => {
    events.value.push({
      id: generateId<GlobalEventId>(),
      timestamp: Date.now(),
      type,
      source,
      message,
      details,
    });
  };

  /**
   * Specialized helper for errors.
   */
  const addErrorEvent = ({ source, message, details }: { source: string, message: string, details?: ErrorDetailValue }) => {
    addEvent({ type: 'error', source, message, details });
  };

  /**
   * Specialized helper for info logs.
   */
  const addInfoEvent = ({ source, message, details }: { source: string, message: string, details?: ErrorDetailValue }) => {
    addEvent({ type: 'info', source, message, details });
  };

  const clearEvents = () => {
    events.value = [];
  };

  return {
    events: computed(() => events.value),
    eventCount: computed(() => events.value.length),
    errorCount: computed(() => events.value.filter(e => e.type === 'error').length),
    addEvent,
    addErrorEvent,
    addInfoEvent,
    clearEvents,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
