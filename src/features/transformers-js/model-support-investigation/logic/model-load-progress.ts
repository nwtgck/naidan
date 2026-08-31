import type { ProgressInfo, TransformersJsModelLoadProgressObservation } from "@/features/transformers-js/types";
import type { OpfsModelCacheMatchObservation } from "@/features/transformers-js/runtime/opfs-model-cache";

const MINIMUM_PUBLISH_INTERVAL_MS = 1000;

export function createModelLoadProgressTracker({ candidateId }: {
  candidateId: string,
}) {
  const perFileLoaded = new Map<string, number>();
  let eventCount = 0;
  let progressEventCount = 0;
  let progressTotalEventCount = 0;
  let forwardProgressCount = 0;
  let repeatedWithoutForwardProgressCount = 0;
  let publishedSampleCount = 0;
  let lastPublishedActivityCount = 0;
  let cacheMatchRequestCount = 0;
  let cacheHitCount = 0;
  let cacheMissCount = 0;
  let cacheAliasHitCount = 0;
  let cacheMatchedBytes = 0;
  let remoteFetchAttemptCount = 0;
  let currentFile: string | undefined;
  let fileLoaded: number | undefined;
  let fileTotal: number | undefined;
  let fileProgress: number | undefined;
  let aggregateLoaded: number | undefined;
  let aggregateTotal: number | undefined;
  let aggregateProgress: number | undefined;
  let firstActivityAt: string | undefined;
  let lastActivityAt: string | undefined;
  let lastForwardProgressAt: string | undefined;
  let lastSourceStatus: string | undefined;
  let lastPublishedAtMs = Number.NEGATIVE_INFINITY;

  const activityCount = (): number => eventCount + cacheMatchRequestCount + remoteFetchAttemptCount;
  const publishCurrent = (): TransformersJsModelLoadProgressObservation | undefined => {
    if (activityCount() === 0 || firstActivityAt === undefined || lastActivityAt === undefined || lastSourceStatus === undefined) {
      return undefined;
    }
    publishedSampleCount += 1;
    lastPublishedActivityCount = activityCount();
    return {
      kind: "model-load",
      artifactSource: "downloaded-model-cache",
      artifactSourceBasis: "load-policy",
      candidateId,
      sourceStatus: lastSourceStatus,
      progressByteSemantics: 'response-body-read-not-network-proof',
      currentFile,
      fileLoaded,
      fileTotal,
      fileProgress,
      aggregateLoaded,
      aggregateTotal,
      aggregateProgress,
      eventCount,
      progressEventCount,
      progressTotalEventCount,
      forwardProgressCount,
      repeatedWithoutForwardProgressCount,
      publishedSampleCount,
      cacheMatchRequestCount,
      cacheHitCount,
      cacheMissCount,
      cacheAliasHitCount,
      cacheMatchedBytes,
      remoteFetchAttemptCount,
      firstActivityAt,
      lastActivityAt,
      lastForwardProgressAt,
    };
  };

  return {
    observeCacheMatch({ observation, at }: {
      observation: OpfsModelCacheMatchObservation,
      at: string,
    }): void {
      cacheMatchRequestCount += 1;
      switch (observation.result) {
      case "hit":
        cacheHitCount += 1;
        break;
      case "alias-hit":
        cacheHitCount += 1;
        cacheAliasHitCount += 1;
        break;
      case "miss":
        cacheMissCount += 1;
        break;
      default: {
        const _ex: never = observation.result;
        throw new Error(`Unhandled OPFS cache match result: ${_ex}`);
      }
      }
      cacheMatchedBytes += observation.bytes ?? 0;
      firstActivityAt ??= at;
      lastActivityAt = at;
      lastSourceStatus = `cache-${observation.result}`;
    },

    observeRemoteFetchAttempt({ at }: { at: string }): void {
      remoteFetchAttemptCount += 1;
      firstActivityAt ??= at;
      lastActivityAt = at;
      lastSourceStatus = "remote-fetch-attempt";
    },

    observe({ info, at, nowMs }: {
      info: ProgressInfo,
      at: string,
      nowMs: number,
    }): TransformersJsModelLoadProgressObservation | undefined {
      eventCount += 1;
      firstActivityAt ??= at;
      lastActivityAt = at;
      lastSourceStatus = info.status;
      let forwarded = false;

      switch (info.status) {
      case "progress_total": {
        progressTotalEventCount += 1;
        if (typeof info.loaded === "number" && info.loaded > (aggregateLoaded ?? -1)) forwarded = true;
        if (typeof info.progress === "number" && info.progress > (aggregateProgress ?? -1)) forwarded = true;
        aggregateLoaded = info.loaded;
        aggregateTotal = info.total;
        aggregateProgress = info.progress;
        break;
      }
      case "progress": {
        progressEventCount += 1;
        if (info.file !== undefined) {
          const previousLoaded = perFileLoaded.get(info.file);
          if (typeof info.loaded === "number" && (previousLoaded === undefined || info.loaded > previousLoaded)) {
            forwarded = true;
          }
          if (typeof info.loaded === "number") perFileLoaded.set(info.file, info.loaded);
          currentFile = info.file;
        }
        fileLoaded = info.loaded;
        fileTotal = info.total;
        fileProgress = info.progress;
        break;
      }
      case "done":
      case "ready":
        forwarded = true;
        if (info.file !== undefined) currentFile = info.file;
        break;
      default:
        if (info.file !== undefined) currentFile = info.file;
        break;
      }

      if (forwarded) {
        forwardProgressCount += 1;
        repeatedWithoutForwardProgressCount = 0;
        lastForwardProgressAt = at;
      } else {
        repeatedWithoutForwardProgressCount += 1;
      }

      const lifecycleEvent = info.status !== "progress" && info.status !== "progress_total";
      const intervalElapsed = nowMs - lastPublishedAtMs >= MINIMUM_PUBLISH_INTERVAL_MS;
      // Progress callbacks can alternate rapidly across split ONNX files. Never let
      // file changes, byte deltas, or percentage deltas bypass this time bound:
      // otherwise instrumentation can enqueue tens of thousands of Worker→main
      // callbacks and materially change the load being measured. Lifecycle events
      // remain immediate so stage transitions are never hidden.
      if (eventCount !== 1 && !lifecycleEvent && !intervalElapsed) return undefined;

      lastPublishedAtMs = nowMs;
      return publishCurrent();
    },

    // A failed/aborted loader is not guaranteed to emit a final `done`/`ready`
    // callback. Flush the latest counters at an actual candidate boundary so the
    // bounded telemetry still records how much raw activity occurred without
    // publishing every raw callback.
    flush(): TransformersJsModelLoadProgressObservation | undefined {
      if (activityCount() === lastPublishedActivityCount) return undefined;
      return publishCurrent();
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  MINIMUM_PUBLISH_INTERVAL_MS,
};
