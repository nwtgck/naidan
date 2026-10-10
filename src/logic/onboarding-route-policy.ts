const ONBOARDING_EXCLUDED_PATHS = [
  '/image-generation',
  '/audio-generation',
] as const;

/** Only the independent generation areas skip chat setup, including child routes. */
export function isOnboardingExcludedPath({ path }: { path: string }): boolean {
  return ONBOARDING_EXCLUDED_PATHS.some(base => path === base || path.startsWith(`${base}/`));
}

export const TEST_ONLY = {
};
