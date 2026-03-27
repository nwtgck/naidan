/**
 * Transformers.js Model URL Scanner Worker
 *
 * STRATEGY:
 * Transformers.js (and ONNX Runtime) can suffer from Out-of-Memory (OOM) issues
 * when downloading model files (e.g., .onnx) because it sometimes attempts
 * to hold the entire file in memory during the process.
 *
 * To prevent this, this worker implements a "dry-run" or "scan" phase:
 * 1. It intercepts global `fetch`.
 * 2. If a request is for a heavy asset (.onnx, .bin, etc.), it returns a
 *    distinctive 4-byte mock response ([0, 1, 2, 3]) instead of downloading it.
 * 3. It records the URL of every intercepted request.
 * 4. For lightweight metadata (config.json, etc.), it performs a real fetch
 *    so the library can correctly identify the required model structure.
 *
 * This allows us to trigger the library's initialization logic to discover
 * all required URLs without actually consuming large amounts of memory.
 * The collected URLs are then passed to the main worker for safe,
 * stream-based prefetching directly to OPFS.
 */

import * as Comlink from 'comlink';
import {
  AutoTokenizer,
  AutoModelForCausalLM,
  env
} from '@huggingface/transformers';
import type { ITransformersJsScannerWorker, ScannedModelFile, ScanOptions, ScanTask } from './transformers-js.types';

const QWEN_DEBUG_PREFIX = '[naidan-qwen-debug]';

function debugLog({ event, details }: { event: string; details: Record<string, unknown> }): void {
  console.log(`${QWEN_DEBUG_PREFIX} ${event}`, {
    at: new Date().toISOString(),
    ...details,
  });
}

// Configure environment for scanning
env.allowLocalModels = false; // Only scan remote
env.allowRemoteModels = true;
env.useBrowserCache = false;
env.useCustomCache = false;

const originalFetch = self.fetch;
const capturedUrls: Set<string> = new Set();
let fetchCount = 0;
let heavyMockCount = 0;
let metadataFetchCount = 0;
let lastFetchUrl: string | undefined;
let lastHeavyMockUrl: string | undefined;
let lastMetadataFetchUrl: string | undefined;

// Intercept fetch to collect URLs and mock heavy files
self.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : input.toString());
  fetchCount += 1;
  lastFetchUrl = url;

  // Only capture model-related files (huggingface.co or relative models path)
  if (url.includes('huggingface.co') || url.includes('/models/')) {
    capturedUrls.add(url);
  }

  // Identify heavy files that we should mock to save memory/bandwidth during scanning
  const isHeavy = /\.(onnx|safetensors|bin|pth|model|data|wasm)$/i.test(url) ||
                  url.includes('_data') ||
                  url.endsWith('.gz');

  if (isHeavy) {
    heavyMockCount += 1;
    lastHeavyMockUrl = url;
    console.debug(`[scanner-worker] Mocking heavy file: ${url}`);
    // Return a 4-byte distinctive dummy response
    return new Response(new Uint8Array([0, 1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
  }

  // For metadata (JSON/Config), perform actual fetch so transformers.js can proceed
  metadataFetchCount += 1;
  lastMetadataFetchUrl = url;
  return originalFetch(input, init);
};

const scannerWorker: ITransformersJsScannerWorker = {
  async scanModel({ tasks }: ScanOptions): Promise<{ files: ScannedModelFile[] }> {
    const scanStartedAt = performance.now();
    console.log(`[scanner-worker] Starting scan with ${tasks.length} tasks.`);
    capturedUrls.clear();
    fetchCount = 0;
    heavyMockCount = 0;
    metadataFetchCount = 0;
    lastFetchUrl = undefined;
    lastHeavyMockUrl = undefined;
    lastMetadataFetchUrl = undefined;

    for (const task of tasks as ScanTask[]) {
      const taskStartedAt = performance.now();
      console.log(`[scanner-worker] Running task: ${task.type} for ${task.modelId}`);
      debugLog({
        event: 'scanner task start',
        details: {
          modelId: task.modelId,
          taskType: task.type,
          elapsedMs: Math.round(taskStartedAt - scanStartedAt),
        },
      });
      try {
        switch (task.type) {
        case 'tokenizer': {
          const options = {
            ...task.options,
            silent: true,
          };
          await AutoTokenizer.from_pretrained(task.modelId, options).catch(err => {
            console.debug(`[scanner-worker] Tokenizer task ended:`, err.message);
          });
          break;
        }
        case 'causal-lm': {
          const options = {
            ...task.options,
            silent: true,
            device: 'wasm' as const,
          };
          await AutoModelForCausalLM.from_pretrained(task.modelId, options).catch(err => {
            console.debug(`[scanner-worker] Causal-LM task ended:`, err.message);
          });
          break;
        }
        default: {
          const _ex: never = task;
          throw new Error(`Unhandled task type: ${(_ex as unknown as ScanTask).type}`);
        }
        }
        debugLog({
          event: 'scanner task success',
          details: {
            modelId: task.modelId,
            taskType: task.type,
            elapsedMs: Math.round(performance.now() - scanStartedAt),
            taskElapsedMs: Math.round(performance.now() - taskStartedAt),
            capturedUrlCount: capturedUrls.size,
            fetchCount,
            heavyMockCount,
            metadataFetchCount,
            lastFetchUrl,
            lastHeavyMockUrl,
            lastMetadataFetchUrl,
          },
        });
      } catch (err) {
        console.debug(`[scanner-worker] Task failed:`, err);
        debugLog({
          event: 'scanner task failure',
          details: {
            modelId: task.modelId,
            taskType: task.type,
            elapsedMs: Math.round(performance.now() - scanStartedAt),
            taskElapsedMs: Math.round(performance.now() - taskStartedAt),
            capturedUrlCount: capturedUrls.size,
            fetchCount,
            heavyMockCount,
            metadataFetchCount,
            lastFetchUrl,
            lastHeavyMockUrl,
            lastMetadataFetchUrl,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    const files = Array.from(capturedUrls).map(url => ({ url }));
    debugLog({
      event: 'scanner complete',
      details: {
        elapsedMs: Math.round(performance.now() - scanStartedAt),
        fileCount: files.length,
        fetchCount,
        heavyMockCount,
        metadataFetchCount,
        lastFetchUrl,
        lastHeavyMockUrl,
        lastMetadataFetchUrl,
      },
    });
    console.log(`[scanner-worker] Scan complete. Found ${files.length} URLs:`, Array.from(capturedUrls));
    return { files };
  }
};

Comlink.expose(scannerWorker);
