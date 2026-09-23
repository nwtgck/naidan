import { describe, expect, it } from 'vitest';
import { createPWAInstallFailure, pwaInstallFailureSchema } from './install-diagnostics';

const context = { scope: 'https://example.test/naidan/', buildId: 'new', resourceUrl: 'https://example.test/naidan/runtime.wasm.gz' };

describe('bounded PWA install diagnostics', () => {
  it('preserves the original error identity, stack, resource and response status', () => {
    const error = Object.assign(new Error('Bad response'), { name: 'bad-precaching-response', details: { status: 404, ignored: 'private' } });
    const failure = createPWAInstallFailure({ ...context, error });
    expect(failure).toMatchObject({ ...context, error: { name: error.name, message: error.message, stack: error.stack, status: 404 } });
    expect(failure.error).not.toHaveProperty('details');
    expect(pwaInstallFailureSchema.safeParse(failure).success).toBe(true);
  });

  it('does not invent an HTTP status for network or cache errors', () => {
    for (const error of [new TypeError('Failed to fetch'), Object.assign(new Error('Cache full'), { name: 'QuotaExceededError' })]) {
      expect(createPWAInstallFailure({ ...context, error }).error).not.toHaveProperty('status');
    }
  });

  it('bounds outgoing diagnostics and rejects invalid incoming payloads', () => {
    const error = Object.assign(new Error('x'.repeat(5000)), { name: 'n'.repeat(500), stack: 's'.repeat(20000) });
    const failure = createPWAInstallFailure({ ...context, error });
    expect(failure.error.name).toHaveLength(200);
    expect(failure.error.message).toHaveLength(4096);
    expect(failure.error.stack).toHaveLength(16000);
    for (const data of [undefined, { ...failure, protocol: 'other' }, { ...failure, buildId: '' }, { ...failure, resourceUrl: 'x'.repeat(5000) }, { ...failure, error: { ...failure.error, status: '404' } }]) {
      expect(pwaInstallFailureSchema.safeParse(data).success).toBe(false);
    }
  });
});
