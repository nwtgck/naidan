/** This is an implementation-specific advisory, not capability detection.
 * Firefox's timer polling issue is not OS-specific:
 * https://bugzilla.mozilla.org/show_bug.cgi?id=1870699
 * Keep the policy here so a confirmed fixed release can retire the warning.
 * Do not guess a fixed version or use this to select an inference profile.
 */
export function hasFirefoxWebGpuPollingIssue({ userAgent }: { userAgent: string }): boolean {
  // Firefox for iOS uses FxiOS rather than the affected Firefox/Gecko token.
  // Gecko derivatives that retain Firefox/... should receive the same advice.
  return /\bFirefox\/\d+/u.test(userAgent) && !/\bFxiOS\//u.test(userAgent);
}

export const TEST_ONLY = {
};
