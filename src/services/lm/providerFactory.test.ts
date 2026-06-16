import { afterEach, describe, expect, it } from 'vitest';
import { fakeLmFetch } from '@/services/fake-lm/api/fakeLmFetch';
import { useFakeLmDebugMode } from '@/services/fake-lm';
import { createLmFetch } from '@/services/lm/providerFactory';

describe('createLmFetch', () => {
  afterEach(() => {
    const { setFakeLmDebugModeStatus } = useFakeLmDebugMode();
    setFakeLmDebugModeStatus({ status: 'disabled' });
  });

  it('returns fake fetch only when debug mode is enabled for the fake endpoint', async () => {
    const { setFakeLmDebugModeStatus } = useFakeLmDebugMode();

    setFakeLmDebugModeStatus({ status: 'disabled' });
    expect(createLmFetch({ endpointUrl: 'https://fake-lm.invalid' })).not.toBe(fakeLmFetch);

    setFakeLmDebugModeStatus({ status: 'enabled' });
    const fakeFetch = createLmFetch({ endpointUrl: 'https://fake-lm.invalid' });
    expect(fakeFetch).toBe(fakeLmFetch);
    const response = await fakeFetch('https://fake-lm.invalid/v1/models');
    expect(response.ok).toBe(true);

    const normalFetch = createLmFetch({ endpointUrl: 'https://example.com' });
    expect(normalFetch).not.toBe(fakeFetch);
  });
});
