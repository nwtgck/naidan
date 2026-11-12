// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  READ_ENV_VITEST, READ_ENV_GIT_INDEX_FILE, READ_ENV_LCORE_TEST_PROFILE,
  READ_ENV_NAIDAN_STABLE_DIFFUSION_CORE_DIR, READ_ENV_PATH, READ_ENV_HOME,
  READ_ENV_XDG_CONFIG_HOME, READ_ENV_TMPDIR, READ_ENV_SYSTEMROOT, READ_ENV_WINDIR,
  READ_ENV_USERPROFILE, READ_ENV_HOMEDRIVE, READ_ENV_HOMEPATH, READ_ENV_TEMP, READ_ENV_TMP,
} from './node-env';

// Import first: these tests must detect accidentally cached module-time values.
afterEach(() => vi.unstubAllEnvs());

describe('lazy Node environment readers', () => {
  it.each([
    { key: 'VITEST', read: READ_ENV_VITEST },
    { key: 'GIT_INDEX_FILE', read: READ_ENV_GIT_INDEX_FILE },
    { key: 'LCORE_TEST_PROFILE', read: READ_ENV_LCORE_TEST_PROFILE },
    { key: 'NAIDAN_STABLE_DIFFUSION_CORE_DIR', read: READ_ENV_NAIDAN_STABLE_DIFFUSION_CORE_DIR },
    { key: 'PATH', read: READ_ENV_PATH },
    { key: 'HOME', read: READ_ENV_HOME },
    { key: 'XDG_CONFIG_HOME', read: READ_ENV_XDG_CONFIG_HOME },
    { key: 'TMPDIR', read: READ_ENV_TMPDIR },
    { key: 'SYSTEMROOT', read: READ_ENV_SYSTEMROOT },
    { key: 'WINDIR', read: READ_ENV_WINDIR },
    { key: 'USERPROFILE', read: READ_ENV_USERPROFILE },
    { key: 'HOMEDRIVE', read: READ_ENV_HOMEDRIVE },
    { key: 'HOMEPATH', read: READ_ENV_HOMEPATH },
    { key: 'TEMP', read: READ_ENV_TEMP },
    { key: 'TMP', read: READ_ENV_TMP },
  ])('reads the current $key without defaults, coercion or caching', ({ key, read }) => {
    const original = read();
    vi.stubEnv(key, 'first');
    expect(read()).toBe('first');
    vi.stubEnv(key, 'second');
    expect(read()).toBe('second');
    vi.stubEnv(key, '');
    expect(read()).toBe('');
    vi.stubEnv(key, undefined);
    expect(read()).toBeUndefined();
    vi.unstubAllEnvs();
    expect(read()).toBe(original);
  });
});
