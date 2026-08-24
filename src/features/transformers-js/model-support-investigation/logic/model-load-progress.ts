import type { ProgressInfo } from "@/features/transformers-js/types";
import type { ModelSupportInvestigationProgressObservation } from "@/features/transformers-js/model-support-investigation/types";

const MINIMUM_PUBLISH_INTERVAL_MS = 1000;
const MINIMUM_PUBLISH_BYTE_DELTA = 1024 * 1024;
const MINIMUM_PUBLISH_PERCENTAGE_DELTA = 1;

export function createModelLoadProgressTracker({ candidateId }: {
  candidateId: string,
}) {
  const perFileLoaded = new Map<string, number>();
  let eventCount = 0;
  let progressEventCount = 0;
  let progressTotalEventCount = 0;
  let forwardProgressCount = 0;
  let repeatedWithoutForwardProgressCount = 0;
  let currentFile: string | undefined;
  let fileLoaded: number | undefined;
  let fileTotal: number | undefined;
  let fileProgress: number | undefined;
  let aggregateLoaded: number | undefined;
  let aggregateTotal: number | undefined;
  let aggregateProgress: number | undefined;
  let lastForwardProgressAt: string | undefined;
  let lastPublishedAtMs = Number.NEGATIVE_INFINITY;
  let lastPublishedAggregateLoaded = 0;
  let lastPublishedAggregateProgress = 0;
  let lastPublishedFile: string | undefined;

  return {
    observe({ info, at, nowMs }: {
      info: ProgressInfo,
      at: string,
      nowMs: number,
    }): ModelSupportInvestigationProgressObservation | undefined {
      eventCount += 1;
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

      const aggregateByteDelta = (aggregateLoaded ?? 0) - lastPublishedAggregateLoaded;
      const aggregatePercentageDelta = (aggregateProgress ?? 0) - lastPublishedAggregateProgress;
      const fileChanged = currentFile !== undefined && currentFile !== lastPublishedFile;
      const lifecycleEvent = info.status !== "progress" && info.status !== "progress_total";
      const intervalElapsed = nowMs - lastPublishedAtMs >= MINIMUM_PUBLISH_INTERVAL_MS;
      const significantForwardProgress = forwarded && (
        aggregateByteDelta >= MINIMUM_PUBLISH_BYTE_DELTA
        || aggregatePercentageDelta >= MINIMUM_PUBLISH_PERCENTAGE_DELTA
      );
      if (eventCount !== 1 && !fileChanged && !lifecycleEvent && !intervalElapsed && !significantForwardProgress) {
        return undefined;
      }

      lastPublishedAtMs = nowMs;
      lastPublishedAggregateLoaded = aggregateLoaded ?? lastPublishedAggregateLoaded;
      lastPublishedAggregateProgress = aggregateProgress ?? lastPublishedAggregateProgress;
      lastPublishedFile = currentFile;

      return {
        kind: "model-load",
        candidateId,
        sourceStatus: info.status,
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
        lastActivityAt: at,
        lastForwardProgressAt,
      };
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  MINIMUM_PUBLISH_INTERVAL_MS,
};
