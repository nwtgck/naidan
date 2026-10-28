// Unrelated members must remain allowed, including on Worker endpoints.
declare const worker: Worker;
declare const channel: BroadcastChannel;
declare const plain: {
  postMessage(value: object): void;
  onmessage: null;
  addEventListener(name: string, callback: () => void): void;
};
worker.terminate();
worker['terminate']();
worker[`terminate`]();
worker.addEventListener('error', () => {});
worker?.addEventListener?.(`error`, () => {});
Reflect.get(worker, 'terminate');
Reflect.get(worker, `onerror`);
Reflect.set(worker, 'onerror', null);
const { terminate, ['onerror']: onerror, ...rest } = worker;
const { 0: first } = [worker];
window.parent.postMessage({}, '*');
channel.postMessage({});
plain.postMessage({});
plain.onmessage = null;
plain.addEventListener('message', () => {});
Reflect.get(plain, 'postMessage');
const { postMessage } = plain;
