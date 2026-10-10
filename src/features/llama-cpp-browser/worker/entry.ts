import { memoryDiagnosticSchema } from '@/features/llama-cpp-browser/memory-diagnostics';
import { subscribeMemoryDiagnostics } from '@/features/llama-cpp-browser/runtime/memory-diagnostics';
import { exposeWorkerRemote, postWorkerNotification } from "@/utils/worker-transport";
import { createWorkerApi } from "./api";
import type { LlamaCppWorkerApi } from "./types";

subscribeMemoryDiagnostics({ listener: ({ diagnostic }) => postWorkerNotification({ endpoint: undefined, schema: memoryDiagnosticSchema, value: diagnostic }) });

exposeWorkerRemote<LlamaCppWorkerApi>({ api: createWorkerApi(), endpoint: undefined });
export const TEST_ONLY = {
};
