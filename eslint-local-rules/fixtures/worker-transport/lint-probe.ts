import * as Comlink from 'comlink';

interface DerivedWorker extends Worker {
  readonly derived: true;
}

export function probe({
  worker,
  port,
  scope,
  channel,
  derivedWorker,
}: {
  worker: Worker;
  port: MessagePort;
  scope: DedicatedWorkerGlobalScope;
  channel: BroadcastChannel;
  derivedWorker: DerivedWorker;
}) {
  worker.postMessage({ type: 'worker' });
  worker.addEventListener('message', () => {});
  port.postMessage({ type: 'port' });
  port.onmessage = () => {};
  scope.postMessage({ type: 'scope' });
  scope.addEventListener('message', () => {});
  derivedWorker.postMessage({ type: 'derived-worker' });
  derivedWorker.onmessage = () => {};
  worker['postMessage']({ type: 'computed-worker' });
  worker['onmessage'] = () => {};
  const messageEvent = 'message' as const;
  worker.addEventListener(messageEvent, () => {});
  const { postMessage: detachedPostMessage, addEventListener: detachedAddEventListener } = worker;
  detachedPostMessage.call(worker, { type: 'detached-worker' });
  detachedAddEventListener.call(worker, 'message', () => {});
  const dynamicMember = 'postMessage' as const;
  const { [dynamicMember]: detachedComputedPostMessage } = worker;
  detachedComputedPostMessage.call(worker, { type: 'detached-computed-worker' });
  Reflect.get(worker, 'postMessage').call(worker, { type: 'reflect-worker' });
  Reflect.set(worker, 'onmessage', () => {});
  const reflectedMember: string = 'postMessage';
  Reflect.get(worker, reflectedMember);

  window.parent.postMessage({ type: 'window' }, '*');
  window.addEventListener('message', () => {});
  channel.postMessage({ type: 'broadcast' });
  channel.onmessage = () => {};
  return Comlink;
}
