import { onMounted, onUnmounted } from 'vue';

type EventMapFor<T> =
  T extends Window ? WindowEventMap :
  T extends Document ? DocumentEventMap :
  T extends HTMLElement ? HTMLElementEventMap :
  T extends SVGElement ? SVGElementEventMap :
  T extends MathMLElement ? MathMLElementEventMap :
  T extends MediaQueryList ? MediaQueryListEventMap :
  T extends AbortSignal ? AbortSignalEventMap :
  T extends FileReader ? FileReaderEventMap :
  T extends WebSocket ? WebSocketEventMap :
  T extends EventSource ? EventSourceEventMap :
  T extends BroadcastChannel ? BroadcastChannelEventMap :
  T extends Worker ? WorkerEventMap :
  T extends ServiceWorker ? ServiceWorkerEventMap :
  T extends IDBDatabase ? IDBDatabaseEventMap :
  T extends IDBOpenDBRequest ? IDBOpenDBRequestEventMap :
  T extends IDBRequest ? IDBRequestEventMap :
  Record<string, Event>;

// Exception to the named-args rule:
// this helper intentionally mirrors addEventListener/removeEventListener so
// call sites stay close to the browser API and inline listener adapters remain concise.
export function useEventTargetListener<
  T extends EventTarget,
  K extends keyof EventMapFor<T> & string,
>(
  target: T,
  type: K,
  listener: (event: EventMapFor<T>[K]) => void,
  options?: AddEventListenerOptions | boolean,
) {
  onMounted(() => {
    target.addEventListener(type, listener as EventListener, options);
  });

  onUnmounted(() => {
    target.removeEventListener(type, listener as EventListener, options);
  });
}
