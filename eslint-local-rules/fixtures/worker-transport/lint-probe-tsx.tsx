import * as Comlink from "comlink";

declare const worker: Worker;
worker.postMessage({ type: "tsx" });
void Comlink;

export const probe = <div />;
