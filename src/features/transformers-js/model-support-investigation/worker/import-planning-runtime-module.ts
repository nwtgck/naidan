// Origin and fingerprint validation belong to runRuntimeIntegrityPreflight.
// This boundary performs only the browser's native module evaluation.
export async function importPlanningRuntimeModule({ url }: { url: string }): Promise<void> {
  await import(/* @vite-ignore */ url);
}

export const TEST_ONLY = {
};
