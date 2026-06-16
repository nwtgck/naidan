import { describe, expect, it } from 'vitest';

import { createFakeLmFetchForEndpoint, FAKE_LM_ENDPOINT_URL, isFakeLmEndpointUrl, useFakeLmDebugMode } from '@/services/fake-lm/index-standalone';

describe('fake LM standalone facade', () => {
  it('keeps fake LM unavailable and disabled', () => {
    const { fakeLmDebugModeAvailability, fakeLmDebugModeStatus, setFakeLmDebugModeStatus } = useFakeLmDebugMode();

    expect(fakeLmDebugModeAvailability.value).toBe('unavailable_in_standalone');
    expect(fakeLmDebugModeStatus.value).toBe('disabled');

    setFakeLmDebugModeStatus({ status: 'enabled' });

    expect(fakeLmDebugModeAvailability.value).toBe('unavailable_in_standalone');
    expect(fakeLmDebugModeStatus.value).toBe('disabled');
  });

  it('does not provide a fake LM fetcher in standalone', () => {
    expect(createFakeLmFetchForEndpoint({ endpointUrl: FAKE_LM_ENDPOINT_URL })).toBeUndefined();
  });

  it('still exposes the fake LM endpoint URL helper for disabled UI copy', () => {
    expect(isFakeLmEndpointUrl({ endpointUrl: FAKE_LM_ENDPOINT_URL })).toBe(true);
  });
});
