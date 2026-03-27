import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { normalizePath, resolvePath } from '@/services/wesh/path';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';

function generateRandomToken({ length }: { length: number }): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let index = 0; index < length; index++) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)]!;
  }
  return result;
}

function resolveMktempBaseDir({
  context,
  tmpDir,
  deprecatedTmp,
  templateProvided,
}: {
  context: WeshCommandContext;
  tmpDir: string | undefined;
  deprecatedTmp: boolean;
  templateProvided: boolean;
}): string {
  const envTmpDir = context.env.get('TMPDIR');
  const defaultTmpDir = envTmpDir === undefined || envTmpDir.length === 0 ? '/tmp' : envTmpDir;

  if (tmpDir !== undefined) {
    return resolvePath({
      cwd: context.cwd,
      path: tmpDir,
    });
  }

  if (deprecatedTmp || !templateProvided) {
    return resolvePath({
      cwd: context.cwd,
      path: defaultTmpDir,
    });
  }

  return context.cwd;
}

function buildMktempTemplate({
  template,
  suffix,
}: {
  template: string;
  suffix: string;
}): { ok: true; value: string } | { ok: false; message: string } {
  if (suffix.includes('/')) {
    return { ok: false, message: "suffix must not contain '/'" };
  }

  const lastSlashIndex = template.lastIndexOf('/');
  const finalComponent = lastSlashIndex === -1 ? template : template.slice(lastSlashIndex + 1);
  if (!/X{3,}/u.test(finalComponent)) {
    return { ok: false, message: "template must contain at least 3 consecutive 'X' characters in the last component" };
  }

  return { ok: true, value: `${template}${suffix}` };
}

function createCandidatePath({
  baseDir,
  template,
}: {
  baseDir: string;
  template: string;
}): string {
  const candidate = template.replace(/X+/gu, (match) => generateRandomToken({ length: match.length }));
  if (candidate.startsWith('/')) {
    return normalizePath({
      cwd: '/',
      path: candidate,
    });
  }

  return normalizePath({
    cwd: baseDir,
    path: candidate,
  });
}

const mktempArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'd', long: 'directory', effects: [{ key: 'directory', value: true }], help: { summary: 'create a directory, not a file', category: 'common' } },
    { kind: 'flag', short: 'h', long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'value', short: 'p', long: 'tmpdir', key: 'tmpDir', valueName: 'DIR', allowAttachedValue: true, parseValue: undefined, help: { summary: 'interpret TEMPLATE relative to DIR', valueName: 'DIR', category: 'common' } },
    { kind: 'flag', short: 'q', long: 'quiet', effects: [{ key: 'quiet', value: true }], help: { summary: 'suppress diagnostics on failure', category: 'common' } },
    { kind: 'value', short: undefined, long: 'suffix', key: 'suffix', valueName: 'SUFF', allowAttachedValue: true, parseValue: undefined, help: { summary: 'append SUFF to TEMPLATE', valueName: 'SUFF', category: 'advanced' } },
    { kind: 'flag', short: 't', long: undefined, effects: [{ key: 'deprecatedTmp', value: true }], help: { summary: 'interpret TEMPLATE as a single file name component under the temp directory', category: 'advanced' } },
    { kind: 'flag', short: 'u', long: 'dry-run', effects: [{ key: 'dryRun', value: true }], help: { summary: 'print a name without creating anything', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const mktempCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'mktemp',
    description: 'Create a temporary file or directory',
    usage: 'mktemp [OPTION]... [TEMPLATE]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: mktempArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'mktemp',
        message: `mktemp: ${diagnostic.message}`,
        argvSpec: mktempArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'mktemp',
        argvSpec: mktempArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 1) {
      await writeCommandUsageError({
        context,
        command: 'mktemp',
        message: 'mktemp: too many templates',
        argvSpec: mktempArgvSpec,
      });
      return { exitCode: 1 };
    }

    const templateInput = parsed.positionals[0];
    const templateProvided = templateInput !== undefined;
    const baseDir = resolveMktempBaseDir({
      context,
      tmpDir: parsed.optionValues.tmpDir as string | undefined,
      deprecatedTmp: parsed.optionValues.deprecatedTmp === true,
      templateProvided,
    });
    const defaultTemplate = 'tmp.XXXXXXXXXX';
    const rawTemplate = templateInput ?? defaultTemplate;
    const suffix = (parsed.optionValues.suffix as string | undefined) ?? '';

    if ((parsed.optionValues.tmpDir !== undefined || parsed.optionValues.deprecatedTmp === true) && rawTemplate.startsWith('/')) {
      await context.text().error({ text: 'mktemp: template must not be absolute when using -p, --tmpdir, or -t\n' });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.deprecatedTmp === true && rawTemplate.includes('/')) {
      await context.text().error({ text: 'mktemp: template must not contain directory separators with -t\n' });
      return { exitCode: 1 };
    }

    const normalizedTemplate = buildMktempTemplate({
      template: rawTemplate,
      suffix,
    });
    if (!normalizedTemplate.ok) {
      await context.text().error({ text: `mktemp: ${normalizedTemplate.message}\n` });
      return { exitCode: 1 };
    }

    for (let attempt = 0; attempt < 100; attempt++) {
      const candidatePath = createCandidatePath({
        baseDir,
        template: normalizedTemplate.value,
      });

      try {
        if (parsed.optionValues.dryRun === true) {
          await context.text().print({ text: `${candidatePath}\n` });
          return { exitCode: 0 };
        }

        if (parsed.optionValues.directory === true) {
          await context.files.mkdir({
            path: candidatePath,
            recursive: false,
          });
        } else {
          const handle = await context.files.open({
            path: candidatePath,
            flags: {
              access: 'write',
              creation: 'always',
              truncate: 'preserve',
              append: 'preserve',
            },
          });
          await handle.close();
        }

        await context.text().print({ text: `${candidatePath}\n` });
        return { exitCode: 0 };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const alreadyExists = /exist|already/u.test(message);
        if (alreadyExists) {
          continue;
        }

        if (parsed.optionValues.quiet !== true) {
          await context.text().error({ text: `mktemp: failed to create '${candidatePath}': ${message}\n` });
        }
        return { exitCode: 1 };
      }
    }

    if (parsed.optionValues.quiet !== true) {
      await context.text().error({ text: 'mktemp: too many attempts to create a unique temporary name\n' });
    }
    return { exitCode: 1 };
  },
};
