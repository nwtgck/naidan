// Comlink preserves Error names, but does not preserve custom prototypes.
export class FileExplorerNotDirectoryError extends Error {
  constructor({ path }: { path: string }) {
    super(`File is not a browsable archive: ${path}`);
    this.name = 'FileExplorerNotDirectoryError';
  }
}

export function isFileExplorerNotDirectoryError({ error }: { error: unknown }): boolean {
  return error instanceof Error && error.name === 'FileExplorerNotDirectoryError';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
