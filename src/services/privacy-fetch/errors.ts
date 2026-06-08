export function createPrivacyFetchError({
  message,
}: {
  message: string;
}): Error {
  return new Error(message)
}
