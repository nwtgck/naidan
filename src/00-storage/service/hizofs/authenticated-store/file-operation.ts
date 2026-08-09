import type { HizoFSWritableBackend, HizoFSWritableFile } from "@/00-storage/service/hizofs/physical-store/backend";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";

async function closeWithSingleRetry({ backend, file }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  file: HizoFSWritableFile;
}): Promise<readonly unknown[]> {
  try {
    await backend.closeFile({ file });
    return [];
  } catch (firstFailure: unknown) {
    try {
      // A close failure may occur before or after the backend actually released the
      // handle. One idempotent retry closes the former case without guessing which
      // outcome occurred; the original failure remains visible to the caller.
      await backend.closeFile({ file });
      return [firstFailure];
    } catch (retryFailure: unknown) {
      return [firstFailure, retryFailure];
    }
  }
}

export async function closeAuthenticatedFile({ backend, file, operationLabel }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  file: HizoFSWritableFile;
  operationLabel: string;
}): Promise<void> {
  const closeFailures = await closeWithSingleRetry({ backend, file });
  if (closeFailures.length === 0) return;
  if (closeFailures.length === 1) throw closeFailures[0];
  throw new AggregateError(closeFailures, `${operationLabel} explicit close failed twice`);
}

export async function runAndCloseAuthenticatedFile({ backend, file, operation, operationLabel }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  file: HizoFSWritableFile;
  operation: () => Promise<void>;
  operationLabel: string;
}): Promise<void> {
  let operationFailed = false;
  let operationFailure: unknown;
  try {
    await operation();
  } catch (cause: unknown) {
    operationFailed = true;
    operationFailure = cause;
  }
  const closeFailures = await closeWithSingleRetry({ backend, file });
  const failures = operationFailed
    ? [operationFailure, ...closeFailures]
    : closeFailures;
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, `${operationLabel} and explicit close failed`);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  closeWithSingleRetry,
};
