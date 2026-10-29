// Deliberately unsafe contracts through several semantic call forms.
import { wrapWorkerRemote as importedWrap, exposeWorkerRemote as importedExpose, ordinary, overloaded } from './worker-api-selection-declarations';
import * as bridges from './worker-api-selection-declarations';
import type { UnsafeApi } from './worker-api-selection-declarations';
export { importedWrap as reexportedWrap };
declare const worker: Worker;
declare const api: UnsafeApi;

ordinary<UnsafeApi>(worker);
overloaded<UnsafeApi>(worker);
const ordinaryAlias = ordinary;
ordinaryAlias<UnsafeApi>(worker);
const alias = importedWrap;
const object = { wrap: importedWrap, expose: importedExpose };
const { wrapWorkerRemote: destructured } = bridges;
function obtainWrap() { return importedWrap; }
const bound = importedWrap.bind(undefined);
let mutable = ordinary;
mutable = importedWrap;
declare const nullable: typeof importedWrap | undefined;
declare const intersection: typeof importedWrap & typeof ordinary;
declare const union: typeof importedWrap | typeof importedExpose;

importedWrap<UnsafeApi>(worker);
bridges.wrapWorkerRemote<UnsafeApi>(worker);
alias<UnsafeApi>(worker);
object.wrap<UnsafeApi>(worker);
object['wrap']<UnsafeApi>(worker);
destructured<UnsafeApi>(worker);
obtainWrap()<UnsafeApi>(worker);
bound<UnsafeApi>(worker);
(importedWrap)<UnsafeApi>(worker);
importedWrap!<UnsafeApi>(worker);
nullable?.<UnsafeApi>(worker);
intersection<UnsafeApi>(worker);
union<UnsafeApi>(worker);
mutable<UnsafeApi>(worker);
importedExpose(api);
object.expose(api);

// Preserve the original syntactic fallback even when the type is unrelated.
const wrapWorkerRemote = ordinary;
const exposeWorkerRemote = ordinary;
const Comlink = { wrap: ordinary, expose: ordinary };
wrapWorkerRemote<UnsafeApi>(worker);
exposeWorkerRemote<UnsafeApi>(api);
Comlink.wrap<UnsafeApi>(worker);
Comlink.expose<UnsafeApi>(api);

// Method and callable-interface signatures must still use full resolution.
declare const methods: {
  wrapWorkerRemote<T>(worker: Worker): T;
  exposeWorkerRemote<T>(api: T): void;
};
interface Callable { <T>(worker: Worker): T }
declare const callable: Callable;
methods.wrapWorkerRemote<UnsafeApi>(worker);
methods.exposeWorkerRemote<UnsafeApi>(api);
callable<UnsafeApi>(worker);
