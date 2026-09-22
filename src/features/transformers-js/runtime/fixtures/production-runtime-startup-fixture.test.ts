import { beforeEach, expect, it } from 'vitest';
import { initializeProductionEntryFixture, installProductionRuntimeStartupPlatform, productionRuntimeModuleFixtureBytes } from './production-runtime-startup-fixture';

let platform: ReturnType<typeof installProductionRuntimeStartupPlatform>;
beforeEach(() => {
  platform = installProductionRuntimeStartupPlatform({ origin: 'http://localhost' });
});

it('rejects a wrong ready identity after a valid lease rather than returning the direct API', async () => {
  await expect(initializeProductionEntryFixture({ initialize: async ({ requestRuntimeModule }) => {
    await requestRuntimeModule({ variant: 'asyncify', bytes: productionRuntimeModuleFixtureBytes({ variant: 'asyncify' }) });
    return { requestId: '22222222-2222-4222-8222-222222222222' };
  } })).rejects.toMatchObject({ reason: 'invalid-startup-message' });
  expect(platform.createObjectURL).toHaveBeenCalledOnce();
  expect(platform.revokeObjectURL).toHaveBeenCalledOnce();
  expect(platform.blobs.size).toBe(0);
});

it('settles a host hash rejection while the Worker is waiting for its ACK', async () => {
  await expect(initializeProductionEntryFixture({ initialize: async ({ requestRuntimeModule }) => {
    const bytes = productionRuntimeModuleFixtureBytes({ variant: 'asyncify' });
    bytes[0] = bytes[0]! ^ 1;
    return await requestRuntimeModule({ variant: 'asyncify', bytes });
  } })).rejects.toMatchObject({ reason: 'initialization-failed', message: 'Runtime MJS hash differs from the build manifest' });
  expect(platform.createObjectURL).not.toHaveBeenCalled();
});
