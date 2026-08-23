import type { HizoFSAuthenticatedInspectionSession } from "@/00-storage/service/hizofs/inspection";
import type { HizoFSPhysicalInspectionWorker } from "@/features/debug-hizofs/worker/physical-inspection";

export type { HizoFSAuthenticatedInspectionSession } from "@/00-storage/service/hizofs/inspection";

/**
 * Transitional adapter for standalone/passphrase-backed sources. The secret is
 * captured by the source-side closure and never becomes part of the UI-facing
 * session shape.
 */
export function bindHizoFSPhysicalInspectionWorkerPassphrase({
  passphrase,
  worker,
}: {
  passphrase: string;
  worker: HizoFSPhysicalInspectionWorker;
}): HizoFSAuthenticatedInspectionSession {
  const {
    inspectContainer,
    inspectHomeRecord,
    inspectNamespacePath,
    inspectRecord,
    inspectRecordFrame,
    ...unhandledWorker
  } = worker;
  unhandledWorker satisfies Record<PropertyKey, never>;

  return {
    inspectContainer: async () => await inspectContainer({ passphrase }),
    inspectHomeRecord: async ({ maximumPreviewBytes, request }) => await inspectHomeRecord({
      maximumPreviewBytes,
      passphrase,
      request,
    }),
    inspectNamespacePath: async ({ maximumDirectoryEntries, maximumPages, pathComponents }) => await inspectNamespacePath({
      maximumDirectoryEntries,
      maximumPages,
      passphrase,
      pathComponents,
    }),
    inspectRecord: async ({ maximumPreviewBytes, request }) => await inspectRecord({
      maximumPreviewBytes,
      passphrase,
      request,
    }),
    inspectRecordFrame: async ({ request }) => await inspectRecordFrame({
      passphrase,
      request,
    }),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
