// Shared runtime dependencies can become their own output chunks. Keep those
// chunks in the same subtree as the broker, where deployment CORS rules apply.
const brokerRuntimeSourcePaths = [
  '/src/01-models/ids.ts',
  '/src/utils/worker-transport.ts',
];

function isBrokerRuntimeModule({ moduleId }: { moduleId: string }): boolean {
  const normalized = moduleId.replaceAll('\\', '/').split('?')[0] ?? '';
  return normalized.includes('/src/features/privacy-fetch/')
    || normalized.includes('/node_modules/zod/')
    || normalized.includes('/node_modules/comlink/')
    || brokerRuntimeSourcePaths.some(sourcePath => normalized.endsWith(sourcePath));
}

export function isPrivacyFetchBrokerChunk({ chunkInfo }: { chunkInfo: {
  name: string,
  facadeModuleId?: string | null,
  moduleIds?: string[],
} }): boolean {
  if (chunkInfo.name.includes('privacy-fetch')) return true;
  if (chunkInfo.facadeModuleId !== undefined && chunkInfo.facadeModuleId !== null
      && isBrokerRuntimeModule({ moduleId: chunkInfo.facadeModuleId })) return true;
  return chunkInfo.moduleIds?.some(moduleId => isBrokerRuntimeModule({ moduleId })) ?? false;
}

export const TEST_ONLY = {};
