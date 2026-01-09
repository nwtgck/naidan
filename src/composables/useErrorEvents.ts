import { ref, computed } from 'vue';

export type ErrorDetailValue = 
  | string 
  | number 
  | boolean 
  | null 
  | undefined 
  | Error 
  | { [key: string]: ErrorDetailValue } 
  | ErrorDetailValue[];

export interface ErrorEvent {
  id: string;
  timestamp: number;
  message: string;
  details?: ErrorDetailValue;
  source: string;
}

const errorEvents = ref<ErrorEvent[]>([]);

export function useErrorEvents() {
  const addErrorEvent = (params: { source: string; message: string; details?: ErrorDetailValue }) => {
    errorEvents.value.push({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: params.source,
      message: params.message,
      details: params.details,
    });
  };

  const clearErrorEvents = () => {
    errorEvents.value = [];
  };

  return {
    errorEvents: computed(() => errorEvents.value),
    errorEventCount: computed(() => errorEvents.value.length),
    addErrorEvent,
    clearErrorEvents,
  };
}