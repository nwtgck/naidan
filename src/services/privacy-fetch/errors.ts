export const PRIVACY_FETCH_DEFAULT_TIMEOUT_MS = 30_000

export function createPrivacyFetchError({
  message,
}: {
  message: string;
}): Error {
  return new Error(message)
}
