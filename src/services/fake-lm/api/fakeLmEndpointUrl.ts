export const FAKE_LM_ENDPOINT_HOSTNAME = 'fake-lm.invalid';
export const FAKE_LM_ENDPOINT_URL = `https://${FAKE_LM_ENDPOINT_HOSTNAME}`;

export function isFakeLmEndpointUrl({ endpointUrl }: {
  endpointUrl: string | undefined;
}): boolean {
  if (endpointUrl === undefined) {
    return false;
  }

  try {
    const url = new URL(endpointUrl);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname === FAKE_LM_ENDPOINT_HOSTNAME
    );
  } catch {
    return false;
  }
}
