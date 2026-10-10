import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { discoverWorkerEntries } from './bridges/worker-transport.ts';
import type { EffectsConfig } from './config.ts';
import type { EffectDiagnostic } from './diagnostics.ts';

const programInputs = new WeakMap<ts.Program, Map<string, string>>();

export function effectProgramInputs({ program }: { program: ts.Program }): ReadonlyMap<string, string> {
  return programInputs.get(program) ?? new Map();
}

export function digest({ content }: { content: string }): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function resolveProjectPath({ root, relative }: { root: string, relative: string }): string {
  const target = path.resolve(root, relative);
  const resolvedRoot = fs.realpathSync(root);
  const actual = fs.realpathSync(target);
  const difference = path.relative(resolvedRoot, actual);
  if (difference === '..' || difference.startsWith('..' + path.sep) || path.isAbsolute(difference)) throw new Error(`Path escapes the effect project: ${relative}`);
  return target;
}

/** Expand explicit directory entries with TypeScript's inherited project exclusions. */
export function selectEffectEntries({ root, config, files }: { root: string, config: Pick<EffectsConfig, 'tsconfig'>, files: readonly string[] }): readonly string[] {
  const selected = new Set<string>();
  for (const file of files) {
    const absolute = resolveProjectPath({ root, relative: file });
    if (!fs.statSync(absolute).isDirectory()) {
      selected.add(absolute);
      continue;
    }
    const project = resolveProjectPath({ root, relative: config.tsconfig });
    const directory = path.relative(root, absolute).split(path.sep).join('/') || '.';
    const parsed = ts.parseJsonConfigFileContent({ extends: project, files: [], include: [directory + '/**/*.ts'] }, ts.sys, root);
    if (parsed.errors.length > 0) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
    const matches = parsed.fileNames.filter(candidate => {
      const relative = path.relative(absolute, candidate);
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
        && candidate.endsWith('.ts') && !candidate.endsWith('.d.ts') && !candidate.endsWith('.test.ts')
        && !path.relative(root, candidate).split(path.sep).includes('node_modules');
    });
    if (matches.length === 0) throw new Error(`No effect entry files in directory: ${file}`);
    for (const candidate of matches) selected.add(resolveProjectPath({ root, relative: candidate }));
  }
  return [...selected];
}

export function checkModelInputs({ root, config }: { root: string, config: EffectsConfig }): void {
  const seen = new Set<string>();
  for (const model of [...config.models, ...config.vueModels.map(model => ({ ...model, export: '<vue>' })), ...config.workerTransports.map(transport => ({ ...transport, export: transport.wrapExport + "/" + transport.exposeExport }))]) {
    const file = resolveProjectPath({ root, relative: model.file });
    const key = `${file}#${model.export}`;
    if (seen.has(key)) throw new Error(`Duplicate external effect model: ${key}`);
    seen.add(key);
    if (digest({ content: fs.readFileSync(file, 'utf8') }) !== model.sha256) throw new Error(`Reviewed effect model changed: ${key}`);
  }
}

export function createEffectsProgram({ root, config, overlays }: {
  root: string, config: EffectsConfig, overlays: ReadonlyMap<string, string>,
}): ts.Program {
  if (config.files.length === 0) throw new Error('Select at least one effect entry file.');
  if (!Number.isSafeInteger(config.analysisBudget) || config.analysisBudget <= 0) throw new Error('analysisBudget must be a positive safe integer.');
  checkModelInputs({ root, config });
  const inputs = new Map<string, string>();
  const capture = ({ file, content, original }: { file: string, content: string | undefined, original: boolean }): string | undefined => {
    const absolute = path.resolve(file);
    const relative = path.relative(path.resolve(root), absolute);
    if (content !== undefined && !relative.split(path.sep).includes('node_modules') && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
      // TypeScript's reader strips a UTF-8 BOM. Keep source offsets and exact
      // input snapshots aligned with the original bytes; overlays already are.
      if (original && !content.startsWith('\uFEFF')) {
        const bytes = fs.readFileSync(absolute);
        if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) content = '\uFEFF' + content;
      }
      inputs.set(absolute, content);
    }
    return content;
  };
  const configFile = resolveProjectPath({ root, relative: config.tsconfig });
  const parsed = ts.getParsedCommandLineOfConfigFile(configFile, { noEmit: true, incremental: false, composite: false }, {
    ...ts.sys,
    readFile: file => capture({ file, content: ts.sys.readFile(file), original: true }),
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (parsed === undefined || parsed.errors.length > 0) throw new Error(parsed?.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n') ?? 'Invalid effect TypeScript configuration.');
  const options = { ...parsed.options, noEmit: true, incremental: false, composite: false };
  delete options.tsBuildInfoFile;
  const host = ts.createCompilerHost(options, true);
  const originalRead = host.readFile.bind(host);
  host.readFile = file => {
    const overlay = overlays.get(path.resolve(file));
    return capture({ file, content: overlay ?? originalRead(file), original: overlay === undefined });
  };
  // Ambient declarations from the scoped tsconfig provide ordinary types without
  // enrolling other product implementations or silently expanding the effect scope.
  const roots = new Set([
    ...config.files.map(relative => resolveProjectPath({ root, relative })),
    ...parsed.fileNames.filter(file => file.endsWith('.d.ts')),
  ]);
  for (let pass = 0; pass < 64; pass++) {
    const program = ts.createProgram({ rootNames: [...roots], options, host });
    programInputs.set(program, inputs);
    if (config.workerTransports.length === 0) return program;
    const entries = discoverWorkerEntries({ program });
    const additions = entries.filter(entry => !roots.has(entry));
    if (additions.length === 0) return program;
    for (const entry of additions) roots.add(resolveProjectPath({ root, relative: entry }));
  }
  throw new Error('Worker entry discovery exceeded its bounded expansion depth.');
}

export function typescriptDiagnostics({ program }: { program: ts.Program }): EffectDiagnostic[] {
  return ts.getPreEmitDiagnostics(program).map(diagnostic => ({
    file: diagnostic.file?.fileName ?? '',
    start: diagnostic.start ?? 0,
    length: diagnostic.length ?? 1,
    code: 'typescript',
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    related: [],
  }));
}
