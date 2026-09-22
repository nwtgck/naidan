import { exposeWorkerRemote } from "@/utils/worker-transport";
import { createWorkerApi } from "./api";
import type { LlamaCppWorkerApi } from "./types";

exposeWorkerRemote<LlamaCppWorkerApi>({ api: createWorkerApi(), endpoint: undefined });
export const TEST_ONLY = {
};
