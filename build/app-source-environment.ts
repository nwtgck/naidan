import {
  READ_ENV_PATH, READ_ENV_HOME, READ_ENV_XDG_CONFIG_HOME, READ_ENV_TMPDIR,
  READ_ENV_SYSTEMROOT, READ_ENV_WINDIR, READ_ENV_USERPROFILE, READ_ENV_HOMEDRIVE,
  READ_ENV_HOMEPATH, READ_ENV_TEMP, READ_ENV_TMP,
} from './node-env';

/** Inherit OS paths and ordinary user Git configuration, not arbitrary GIT_* overrides. */
export function createAppSourceGitEnvironment({ platform = process.platform }: { platform?: NodeJS.Platform } = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: READ_ENV_PATH(),
    HOME: READ_ENV_HOME(),
    XDG_CONFIG_HOME: READ_ENV_XDG_CONFIG_HOME(),
  };
  switch (platform) {
  case 'win32':
    // Use a single spelling per key: Windows environment names are case-insensitive.
    Object.assign(environment, {
      SYSTEMROOT: READ_ENV_SYSTEMROOT(),
      WINDIR: READ_ENV_WINDIR(),
      USERPROFILE: READ_ENV_USERPROFILE(),
      HOMEDRIVE: READ_ENV_HOMEDRIVE(),
      HOMEPATH: READ_ENV_HOMEPATH(),
      TEMP: READ_ENV_TEMP(),
      TMP: READ_ENV_TMP(),
    });
    break;
  case 'aix':
  case 'android':
  case 'darwin':
  case 'freebsd':
  case 'haiku':
  case 'linux':
  case 'openbsd':
  case 'sunos':
  case 'cygwin':
  case 'netbsd':
    environment.TMPDIR = READ_ENV_TMPDIR();
    break;
  default: {
    const exhaustive: never = platform;
    throw new Error(`Unsupported Node platform: ${exhaustive}`);
  }
  }
  // Absent and empty variables are different; never supply the string "undefined".
  return Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
}
