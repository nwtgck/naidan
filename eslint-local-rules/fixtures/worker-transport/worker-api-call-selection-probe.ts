// No runtime arguments must not hide an explicit contract, including via aliases.
interface UnsafeApi { send(value: { callback: () => void }): void }
declare function wrapWorkerRemote<T>(worker?: Worker): T;
declare function exposeWorkerRemote<T>(api?: T): void;
declare const worker: Worker;
const alias = wrapWorkerRemote;
const exposeAlias = exposeWorkerRemote;
function obtainWrap() { return wrapWorkerRemote }
declare function unrelated<T>(value?: T): T;

wrapWorkerRemote<UnsafeApi>();
exposeWorkerRemote<UnsafeApi>();
alias<UnsafeApi>();
alias<UnsafeApi>(worker);
exposeAlias<UnsafeApi>();
obtainWrap()<UnsafeApi>(worker);
unrelated<UnsafeApi>();
