// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppSourceGitEnvironment } from './app-source-environment';

afterEach(() => vi.unstubAllEnvs());

const common = { PATH: '/git/bin', HOME: '/home/fixture', XDG_CONFIG_HOME: '/home/fixture/.config' };
const posix = { TMPDIR: '/tmp/fixture' };
const windows = { SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows', USERPROFILE: 'C:\\Users\\fixture', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\fixture', TEMP: 'C:\\Temp', TMP: 'C:\\Temp' };

function stubPaths() {
  for (const [key, value] of Object.entries({ ...common, ...posix, ...windows })) {
    vi.stubEnv(key, value);
  }
}

describe('source Git environment allowlist', () => {
  it.each(['linux', 'darwin', 'freebsd'] as const)('retains only named paths on %s', platform => {
    stubPaths();
    vi.stubEnv('PRIVATE_TOKEN', 'must-not-leak');
    expect(createAppSourceGitEnvironment({ platform })).toEqual({ ...common, ...posix });
  });

  it('uses one canonical spelling per Windows key', () => {
    stubPaths();
    const environment = createAppSourceGitEnvironment({ platform: 'win32' });
    expect(environment).toEqual({ ...common, ...windows });
    const keys = Object.keys(environment).map(key => key.toUpperCase());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS', 'GIT_TRACE', 'NODE_OPTIONS', 'PRIVATE_TOKEN'])('does not inherit %s', key => {
    vi.stubEnv(key, 'do-not-inherit');
    expect(createAppSourceGitEnvironment()).not.toHaveProperty(key);
  });

  it('omits absent keys but preserves empty values and reads paths again', () => {
    stubPaths();
    vi.stubEnv('HOME', undefined);
    vi.stubEnv('PATH', '');
    expect(createAppSourceGitEnvironment({ platform: 'linux' })).toEqual({ PATH: '', XDG_CONFIG_HOME: common.XDG_CONFIG_HOME, TMPDIR: posix.TMPDIR });
    vi.stubEnv('PATH', '/new/git/bin');
    expect(createAppSourceGitEnvironment().PATH).toBe('/new/git/bin');
  });

  it('returns independent objects without exposing the real environment', () => {
    stubPaths();
    const first = createAppSourceGitEnvironment();
    const second = createAppSourceGitEnvironment();
    expect(first).not.toBe(second);
    first.PATH = 'changed';
    delete first.HOME;
    expect(createAppSourceGitEnvironment().PATH).toBe(common.PATH);
    expect(createAppSourceGitEnvironment().HOME).toBe(common.HOME);
  });
});
