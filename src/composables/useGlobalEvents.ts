import { generateId } from '../utils/id';
import { ref, computed } from 'vue';

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
  id: string;
  type: EventType;
  timestamp: number;
  message: string;
  details?: ErrorDetailValue;
  source: string;
}

const events = ref<GlobalEvent[]>([]);

export function useGlobalEvents() {
  const addEvent = (params: { type: EventType; source: string; message: string; details?: ErrorDetailValue }) => {
    events.value.push({
      id: generateId(),
      timestamp: Date.now(),
      ...params,
    });
  };

  /**
   * Specialized helper for errors.
   */
  const addErrorEvent = (params: { source: string; message: string; details?: ErrorDetailValue }) => {
    addEvent({ type: 'error', ...params });
  };

  /**
   * Specialized helper for info logs.
   */
  const addInfoEvent = (params: { source: string; message: string; details?: ErrorDetailValue }) => {
    addEvent({ type: 'info', ...params });
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
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}