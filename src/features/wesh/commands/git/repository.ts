import { normalizePath } from "@/features/wesh/path";
import type { WeshCommandContext } from '@/features/wesh/types';
import type { GitFiles } from "./files";
import { pathExists, readFileText, writeFileText } from "./files";

export interface GitRepository {
  worktreePath: string,
  gitDirPath: string,
  commonDirPath: string,
}

export function joinPath({ base, child }: { base: string, child: string }): string {
  return normalizePath({ cwd: base, path: child });
}

function parentPath({ path }: { path: string }): string | undefined {
  if (path === "/") return undefined;
  const slashIndex = path.lastIndexOf("/");
  return slashIndex <= 0 ? "/" : path.slice(0, slashIndex);
}

function parseBooleanConfigValue({ value }: { value: string }): boolean | undefined {
  switch (value.trim().toLowerCase()) {
  case 'true':
  case 'yes':
  case 'on':
  case '1':
    return true;
  case 'false':
  case 'no':
  case 'off':
  case '0':
    return false;
  default:
    return undefined;
  }
}

interface RepositoryFormat {
  version: number,
  extensions: Map<string, string>,
}

function parseRepositoryFormat({ text }: { text: string }): RepositoryFormat {
  let section = '';
  let version = 0;
  const extensions = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = /^\[([^\s\]"]+)(?:\s+"[^"]*")?\]$/u.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1]!.toLowerCase();
      continue;
    }
    const assignment = /^([A-Za-z0-9-]+)(?:\s*=\s*(.*))?$/u.exec(line);
    if (assignment === null) continue;
    const key = assignment[1]!.toLowerCase();
    const value = assignment[2] ?? 'true';
    if (section === 'core' && key === 'repositoryformatversion') {
      const trimmed = value.trim();
      if (!/^\d+$/u.test(trimmed)) throw new Error(`invalid repository format version '${value}'`);
      version = Number.parseInt(trimmed, 10);
    } else if (section === 'extensions') {
      extensions.set(key, value.trim());
    }
  }
  return { version, extensions };
}

async function validateRepositoryFormat({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<void> {
  const configPath = joinPath({ base: repository.commonDirPath, child: 'config' });
  if (!await pathExists({ files, path: configPath })) return;
  const format = parseRepositoryFormat({ text: await readFileText({ files, path: configPath }) });
  if (format.version > 1) throw new Error(`Expected git repo version <= 1, found ${format.version}`);
  if (format.version !== 1) return;
  for (const [name, rawValue] of format.extensions) {
    const value = rawValue.toLowerCase();
    switch (name) {
    case 'objectformat':
      if (value !== 'sha1') throw new Error(`unsupported repository object format '${rawValue}'`);
      break;
    case 'refstorage':
      if (value !== 'files') throw new Error(`unsupported repository ref storage '${rawValue}'`);
      break;
    default:
      throw new Error(`unsupported repository extension '${name}'`);
    }
  }
}

async function directoryHasEntries({ files, path }: { files: GitFiles, path: string }): Promise<boolean> {
  if (!await pathExists({ files, path })) return false;
  for await (const _entry of files.readDir({ path })) return true;
  return false;
}

async function fileHasContent({ files, path }: { files: GitFiles, path: string }): Promise<boolean> {
  return await pathExists({ files, path }) && (await readFileText({ files, path })).trim().length > 0;
}

async function hasReplacementRefs({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<boolean> {
  if (await directoryHasEntries({
    files,
    path: joinPath({ base: repository.commonDirPath, child: 'refs/replace' }),
  })) return true;
  const packedRefsPath = joinPath({ base: repository.commonDirPath, child: 'packed-refs' });
  if (!await pathExists({ files, path: packedRefsPath })) return false;
  return (await readFileText({ files, path: packedRefsPath })).split(/\r?\n/u).some(line => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('#') && /\srefs\/replace\//u.test(trimmed);
  });
}

async function validateRepositoryCapabilities({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<void> {
  if (await hasReplacementRefs({ files, repository })) throw new Error('replacement refs are not supported yet');
  if (await fileHasContent({
    files,
    path: joinPath({ base: repository.commonDirPath, child: 'objects/info/alternates' }),
  })) throw new Error('alternate object databases are not supported yet');
  for (const base of new Set([repository.gitDirPath, repository.commonDirPath])) {
    if (await fileHasContent({ files, path: joinPath({ base, child: 'shallow' }) })) {
      throw new Error('shallow repositories are not supported yet');
    }
  }
}

async function validatedRepository({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitRepository> {
  await validateRepositoryFormat({ files, repository });
  await validateRepositoryCapabilities({ files, repository });
  return repository;
}

async function isBareRepositoryDirectory({ files, path, inferWhenConfigMissing }: {
  files: GitFiles,
  path: string,
  inferWhenConfigMissing: boolean,
}): Promise<boolean> {
  for (const name of ['HEAD', 'objects', 'refs']) {
    if (!await pathExists({ files, path: joinPath({ base: path, child: name }) })) return false;
  }
  const configPath = joinPath({ base: path, child: 'config' });
  if (!await pathExists({ files, path: configPath })) return inferWhenConfigMissing;
  const configText = await readFileText({ files, path: configPath });
  let section = '';
  for (const rawLine of configText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = /^\[([^\s\]"]+)(?:\s+"[^"]*")?\]$/u.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1]!.toLowerCase();
      continue;
    }
    if (section !== 'core') continue;
    const assignment = /^bare\s*=\s*(.*)$/iu.exec(line);
    if (assignment === null) continue;
    return parseBooleanConfigValue({ value: assignment[1]! }) === true;
  }
  return false;
}

export function repositoryHasWorktree({ repository }: { repository: GitRepository }): boolean {
  return repository.worktreePath !== repository.gitDirPath;
}

export function assertRepositoryHasWorktree({ repository }: { repository: GitRepository }): void {
  if (!repositoryHasWorktree({ repository })) throw new Error('this operation must be run in a work tree');
}

export function repositoryCwdIsInsideWorktree({ context, repository }: {
  context: WeshCommandContext,
  repository: GitRepository,
}): boolean {
  if (!repositoryHasWorktree({ repository })) return false;
  const worktreePrefix = repository.worktreePath === '/' ? '/' : `${repository.worktreePath}/`;
  const insideWorktree = context.cwd === repository.worktreePath || context.cwd.startsWith(worktreePrefix);
  if (!insideWorktree) return false;
  if (context.env.has('GIT_DIR')) return true;
  const gitDirPrefix = repository.gitDirPath === '/' ? '/' : `${repository.gitDirPath}/`;
  return context.cwd !== repository.gitDirPath && !context.cwd.startsWith(gitDirPrefix);
}

export function assertRepositoryHasUsableWorktree({ context, repository }: {
  context: WeshCommandContext,
  repository: GitRepository,
}): void {
  assertRepositoryHasWorktree({ repository });
  if (context.env.has('GIT_DIR') || context.env.has('GIT_WORK_TREE')) return;
  if (!repositoryCwdIsInsideWorktree({ context, repository })) throw new Error('this operation must be run in a work tree');
}

async function resolveCommonDir({ files, gitDirPath }: {
  files: GitFiles,
  gitDirPath: string,
}): Promise<string> {
  const commonDirFilePath = joinPath({ base: gitDirPath, child: 'commondir' });
  if (!await pathExists({ files, path: commonDirFilePath })) return gitDirPath;
  const relativeCommonDir = (await readFileText({ files, path: commonDirFilePath })).trim();
  if (relativeCommonDir.length === 0) throw new Error(`Invalid commondir file: ${commonDirFilePath}`);
  const commonDirPath = normalizePath({ cwd: gitDirPath, path: relativeCommonDir });
  const stat = await files.stat({ path: commonDirPath });
  switch (stat.type) {
  case 'directory':
    return commonDirPath;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`Git common directory is not a directory: ${commonDirPath}`);
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled common directory type: ${_ex}`);
  }
  }
}

async function resolveGitDirFromMarker({ files, markerPath, worktreePath }: {
  files: GitFiles,
  markerPath: string,
  worktreePath: string,
}): Promise<string | undefined> {
  let markerStat;
  try {
    markerStat = await files.lstat({ path: markerPath });
  } catch {
    return undefined;
  }

  switch (markerStat.type) {
  case "directory":
    return markerPath;
  case "file": {
    const markerText = (await readFileText({ files, path: markerPath })).trim();
    const match = /^gitdir:\s*(.+)$/u.exec(markerText);
    if (match === null) {
      throw new Error(`Invalid gitfile format: ${markerPath}`);
    }
    return normalizePath({ cwd: worktreePath, path: match[1]! });
  }
  case "fifo":
  case "chardev":
  case "symlink":
    throw new Error(`Unsupported .git entry type: ${markerStat.type}`);
  default: {
    const _ex: never = markerStat.type;
    throw new Error(`Unhandled .git entry type: ${_ex}`);
  }
  }
}

export async function discoverRepository({ files, cwd }: {
  files: GitFiles,
  cwd: string,
}): Promise<GitRepository> {
  let current = normalizePath({ cwd: "/", path: cwd });
  while (true) {
    const markerPath = joinPath({ base: current, child: ".git" });
    const gitDirPath = await resolveGitDirFromMarker({ files, markerPath, worktreePath: current });
    if (gitDirPath !== undefined) {
      return validatedRepository({
        files,
        repository: {
          worktreePath: current,
          gitDirPath,
          commonDirPath: await resolveCommonDir({ files, gitDirPath }),
        },
      });
    }
    if (await isBareRepositoryDirectory({ files, path: current, inferWhenConfigMissing: true })) {
      return validatedRepository({
        files,
        repository: { worktreePath: current, gitDirPath: current, commonDirPath: current },
      });
    }
    const parent = parentPath({ path: current });
    if (parent === undefined) break;
    current = parent;
  }
  throw new Error("not a git repository (or any of the parent directories): .git");
}

export async function discoverRepositoryFromContext({ context }: {
  context: WeshCommandContext,
}): Promise<GitRepository> {
  const gitDirValue = context.env.get('GIT_DIR');
  const worktreeValue = context.env.get('GIT_WORK_TREE');
  if (gitDirValue === undefined) {
    const repository = await discoverRepository({ files: context.files, cwd: context.cwd });
    if (worktreeValue === undefined) return repository;
    return {
      ...repository,
      worktreePath: normalizePath({ cwd: context.cwd, path: worktreeValue }),
    };
  }

  const gitDirPath = normalizePath({ cwd: context.cwd, path: gitDirValue });
  let stat;
  try {
    stat = await context.files.stat({ path: gitDirPath });
  } catch {
    throw new Error(`not a git repository: '${gitDirValue}'`);
  }
  switch (stat.type) {
  case 'directory':
    break;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`not a git repository: '${gitDirValue}'`);
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled GIT_DIR type: ${_ex}`);
  }
  }
  if (!await pathExists({ files: context.files, path: joinPath({ base: gitDirPath, child: 'HEAD' }) })
    || !await pathExists({ files: context.files, path: joinPath({ base: gitDirPath, child: 'objects' }) })) {
    throw new Error(`not a git repository: '${gitDirValue}'`);
  }
  const bare = await isBareRepositoryDirectory({ files: context.files, path: gitDirPath, inferWhenConfigMissing: false });
  return validatedRepository({
    files: context.files,
    repository: {
      worktreePath: worktreeValue === undefined
        ? bare ? gitDirPath : context.cwd
        : normalizePath({ cwd: context.cwd, path: worktreeValue }),
      gitDirPath,
      commonDirPath: await resolveCommonDir({ files: context.files, gitDirPath }),
    },
  });
}

export async function initializeRepository({ files, targetPath }: {
  files: GitFiles,
  targetPath: string,
}): Promise<{ repository: GitRepository, reinitialized: boolean }> {
  const worktreePath = normalizePath({ cwd: "/", path: targetPath });
  if (!await pathExists({ files, path: worktreePath })) {
    await files.mkdir({ path: worktreePath, recursive: true });
  } else {
    const stat = await files.stat({ path: worktreePath });
    switch (stat.type) {
    case "directory":
      break;
    case "file":
    case "fifo":
    case "chardev":
    case "symlink":
      throw new Error(`cannot mkdir ${worktreePath}: File exists`);
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled worktree type: ${_ex}`);
    }
    }
  }

  const gitDirPath = joinPath({ base: worktreePath, child: ".git" });
  const reinitialized = await pathExists({ files, path: gitDirPath });
  if (!reinitialized) {
    await files.mkdir({ path: gitDirPath, recursive: false });
  } else {
    const stat = await files.stat({ path: gitDirPath });
    switch (stat.type) {
    case "directory":
      break;
    case "file":
    case "fifo":
    case "chardev":
    case "symlink":
      throw new Error(`separate git dir is not supported for init: ${gitDirPath}`);
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled git directory type: ${_ex}`);
    }
    }
  }

  if (reinitialized) {
    await validateRepositoryFormat({
      files,
      repository: {
        worktreePath,
        gitDirPath,
        commonDirPath: await resolveCommonDir({ files, gitDirPath }),
      },
    });
  }

  for (const relativePath of ["branches", "info", "objects", "objects/info", "objects/pack", "refs", "refs/heads", "refs/tags"]) {
    const path = joinPath({ base: gitDirPath, child: relativePath });
    if (!await pathExists({ files, path })) {
      await files.mkdir({ path, recursive: true });
    }
  }

  const headPath = joinPath({ base: gitDirPath, child: "HEAD" });
  if (!await pathExists({ files, path: headPath })) {
    await writeFileText({ files, path: headPath, text: "ref: refs/heads/master\n" });
  }

  const configPath = joinPath({ base: gitDirPath, child: "config" });
  if (!await pathExists({ files, path: configPath })) {
    await writeFileText({
      files,
      path: configPath,
      text: `\
[core]
\trepositoryformatversion = 0
\tfilemode = false
\tbare = false
\tlogallrefupdates = true
`,
    });
  }

  const excludePath = joinPath({ base: gitDirPath, child: "info/exclude" });
  if (!await pathExists({ files, path: excludePath })) {
    await writeFileText({
      files,
      path: excludePath,
      text: `\
# git ls-files --others --exclude-from=.git/info/exclude
# Lines that start with '#' are comments.
`,
    });
  }

  const descriptionPath = joinPath({ base: gitDirPath, child: "description" });
  if (!await pathExists({ files, path: descriptionPath })) {
    await writeFileText({
      files,
      path: descriptionPath,
      text: "Unnamed repository; edit this file description to name the repository.\n",
    });
  }

  return {
    repository: { worktreePath, gitDirPath, commonDirPath: gitDirPath },
    reinitialized,
  };
}

export async function discoverRepositoryAtPath({ files, path }: {
  files: GitFiles,
  path: string,
}): Promise<{ repository: GitRepository, bare: boolean }> {
  const repositoryPath = normalizePath({ cwd: '/', path });
  const stat = await files.stat({ path: repositoryPath });
  switch (stat.type) {
  case 'directory':
    break;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`repository '${path}' does not exist`);
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled repository path type: ${_ex}`);
  }
  }
  const markerPath = joinPath({ base: repositoryPath, child: '.git' });
  if (await pathExists({ files, path: markerPath })) {
    const repository = await discoverRepository({ files, cwd: repositoryPath });
    if (repository.worktreePath !== repositoryPath) throw new Error(`repository '${path}' does not exist`);
    return { repository, bare: false };
  }
  const headPath = joinPath({ base: repositoryPath, child: 'HEAD' });
  const objectsPath = joinPath({ base: repositoryPath, child: 'objects' });
  const refsPath = joinPath({ base: repositoryPath, child: 'refs' });
  if (await pathExists({ files, path: headPath })
    && await pathExists({ files, path: objectsPath })
    && await pathExists({ files, path: refsPath })) {
    return {
      repository: await validatedRepository({
        files,
        repository: { worktreePath: repositoryPath, gitDirPath: repositoryPath, commonDirPath: repositoryPath },
      }),
      bare: true,
    };
  }
  throw new Error(`repository '${path}' does not exist`);
}

export async function initializeBareRepository({ files, targetPath }: {
  files: GitFiles,
  targetPath: string,
}): Promise<{ repository: GitRepository, reinitialized: boolean }> {
  const gitDirPath = normalizePath({ cwd: '/', path: targetPath });
  const reinitialized = await pathExists({ files, path: gitDirPath });
  if (!reinitialized) {
    await files.mkdir({ path: gitDirPath, recursive: true });
  } else {
    const stat = await files.stat({ path: gitDirPath });
    switch (stat.type) {
    case 'directory':
      break;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      throw new Error(`cannot mkdir ${gitDirPath}: File exists`);
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled bare repository path type: ${_ex}`);
    }
    }
  }
  if (reinitialized) {
    await validateRepositoryFormat({
      files,
      repository: { worktreePath: gitDirPath, gitDirPath, commonDirPath: gitDirPath },
    });
  }
  for (const relativePath of ['branches', 'info', 'objects', 'objects/info', 'objects/pack', 'refs', 'refs/heads', 'refs/tags']) {
    const directoryPath = joinPath({ base: gitDirPath, child: relativePath });
    if (!await pathExists({ files, path: directoryPath })) await files.mkdir({ path: directoryPath, recursive: true });
  }
  const headPath = joinPath({ base: gitDirPath, child: 'HEAD' });
  if (!await pathExists({ files, path: headPath })) await writeFileText({ files, path: headPath, text: 'ref: refs/heads/master\n' });
  const configPath = joinPath({ base: gitDirPath, child: 'config' });
  if (!await pathExists({ files, path: configPath })) {
    await writeFileText({
      files,
      path: configPath,
      text: `\
[core]
\trepositoryformatversion = 0
\tfilemode = false
\tbare = true
`,
    });
  }
  const descriptionPath = joinPath({ base: gitDirPath, child: 'description' });
  if (!await pathExists({ files, path: descriptionPath })) {
    await writeFileText({ files, path: descriptionPath, text: 'Unnamed repository; edit this file description to name the repository.\n' });
  }
  return {
    repository: { worktreePath: gitDirPath, gitDirPath, commonDirPath: gitDirPath },
    reinitialized,
  };
}

export function relativeToWorktree({ repository, absolutePath }: {
  repository: GitRepository,
  absolutePath: string,
}): string {
  if (absolutePath === repository.worktreePath) return "";
  const prefix = repository.worktreePath === "/" ? "/" : `${repository.worktreePath}/`;
  if (!absolutePath.startsWith(prefix)) {
    throw new Error(`Path is outside repository worktree: ${absolutePath}`);
  }
  return absolutePath.slice(prefix.length);
}

export const TEST_ONLY = {
  parseRepositoryFormat,
};
