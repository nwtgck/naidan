// The only Node.js environment readers. Keep defaults and parsing at the call site.
export const READ_ENV_VITEST = () => process.env.VITEST;
export const READ_ENV_GIT_INDEX_FILE = () => process.env.GIT_INDEX_FILE;
export const READ_ENV_LCORE_TEST_PROFILE = () => process.env.LCORE_TEST_PROFILE;
export const READ_ENV_NAIDAN_STABLE_DIFFUSION_CORE_DIR = () => process.env.NAIDAN_STABLE_DIFFUSION_CORE_DIR;
export const READ_ENV_PATH = () => process.env.PATH;
export const READ_ENV_HOME = () => process.env.HOME;
export const READ_ENV_XDG_CONFIG_HOME = () => process.env.XDG_CONFIG_HOME;
export const READ_ENV_TMPDIR = () => process.env.TMPDIR;
export const READ_ENV_SYSTEMROOT = () => process.env.SYSTEMROOT;
export const READ_ENV_WINDIR = () => process.env.WINDIR;
export const READ_ENV_USERPROFILE = () => process.env.USERPROFILE;
export const READ_ENV_HOMEDRIVE = () => process.env.HOMEDRIVE;
export const READ_ENV_HOMEPATH = () => process.env.HOMEPATH;
export const READ_ENV_TEMP = () => process.env.TEMP;
export const READ_ENV_TMP = () => process.env.TMP;
