import { compareGitUtf8Strings, sortGitUtf8Strings } from './utf8-order';

export function compareGitPaths({ left, right }: { left: string, right: string }): number {
  return compareGitUtf8Strings({ left, right });
}

export function sortGitPaths({ paths }: { paths: Iterable<string> }): string[] {
  return sortGitUtf8Strings({ values: paths });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
