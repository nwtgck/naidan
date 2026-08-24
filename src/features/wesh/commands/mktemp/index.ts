import { parseStandardArgv, type ParsedStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { normalizePath, resolvePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';

const RANDOM_TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const RANDOM_BYTE_ACCEPTANCE_LIMIT = Math.floor(256 / RANDOM_TOKEN_ALPHABET.length)
  * RANDOM_TOKEN_ALPHABET.length;

function generateRandomToken({ length }: { length: number }): string {
  let result = '';
  const randomBytes = new Uint8Array(Math.min(1024, Math.max(16, length * 2)));
  while (result.length < length) {
    globalThis.crypto.getRandomValues(randomBytes);
    for (const byte of randomBytes) {
      if (byte >= RANDOM_BYTE_ACCEPTANCE_LIMIT) continue;
      result += RANDOM_TOKEN_ALPHABET[byte % RANDOM_TOKEN_ALPHABET.length]!;
      if (result.length === length) return result;
    }
  }
  return result;
}

function resolveMktempBaseDir({
  context,
  tmpDir,
  useDefaultTmpDir,
  templateProvided,
}: {
  context: WeshCommandContext,
  tmpDir: string | undefined,
  useDefaultTmpDir: boolean,
  templateProvided: boolean,
}): {
  resolved: string,
  displayed: string,
} {
  const envTmpDir = context.env.get('TMPDIR');
  const defaultTmpDir = envTmpDir === undefined || envTmpDir.length === 0 ? '/tmp' : envTmpDir;

  if (useDefaultTmpDir) {
    return {
      resolved: resolvePath({
        cwd: context.cwd,
        path: defaultTmpDir,
      }),
      displayed: defaultTmpDir,
    };
  }

  if (tmpDir !== undefined && tmpDir.length > 0) {
    return {
      resolved: resolvePath({
        cwd: context.cwd,
        path: tmpDir,
      }),
      displayed: tmpDir,
    };
  }

  if (tmpDir === '' || !templateProvided) {
    return {
      resolved: resolvePath({
        cwd: context.cwd,
        path: defaultTmpDir,
      }),
      displayed: defaultTmpDir,
    };
  }

  return {
    resolved: context.cwd,
    displayed: '',
  };
}

interface MktempTemplate {
  prefix: string,
  randomLength: number,
  suffix: string,
}

function buildMktempTemplate({
  template,
  suffix,
  suffixProvided,
}: {
  template: string,
  suffix: string,
  suffixProvided: boolean,
}): { ok: true, value: MktempTemplate } | { ok: false, message: string } {
  if (suffix.includes('/')) {
    return { ok: false, message: "suffix must not contain '/'" };
  }

  const finalComponentStart = template.lastIndexOf('/') + 1;
  const finalComponent = template.slice(finalComponentStart);
  const randomEndInFinalComponent = finalComponent.lastIndexOf('X') + 1;
  let randomStartInFinalComponent = randomEndInFinalComponent;
  while (randomStartInFinalComponent > 0 && finalComponent[randomStartInFinalComponent - 1] === 'X') {
    randomStartInFinalComponent -= 1;
  }
  const randomLength = randomEndInFinalComponent - randomStartInFinalComponent;
  if (randomLength < 3) {
    return { ok: false, message: "template must contain at least 3 consecutive 'X' characters in the last component" };
  }

  if (suffixProvided && randomEndInFinalComponent !== finalComponent.length) {
    return { ok: false, message: `with --suffix, template '${template}' must end in 'X'` };
  }

  const randomStart = finalComponentStart + randomStartInFinalComponent;
  const randomEnd = finalComponentStart + randomEndInFinalComponent;
  return {
    ok: true,
    value: {
      prefix: template.slice(0, randomStart),
      randomLength,
      suffix: `${template.slice(randomEnd)}${suffix}`,
    },
  };
}

function createCandidatePath({
  baseDir,
  displayedBaseDir,
  template,
}: {
  baseDir: string,
  displayedBaseDir: string,
  template: MktempTemplate,
}): {
  resolved: string,
  displayed: string,
} {
  const candidate = `${template.prefix}${generateRandomToken({ length: template.randomLength })}${template.suffix}`;
  if (candidate.startsWith('/')) {
    const resolved = normalizePath({
      cwd: '/',
      path: candidate,
    });
    return {
      resolved,
      displayed: resolved,
    };
  }

  return {
    resolved: normalizePath({
      cwd: baseDir,
      path: candidate,
    }),
    displayed: displayedBaseDir.length === 0
      ? candidate
      : `${displayedBaseDir.replace(/\/$/u, '')}/${candidate}`,
  };
}

function parseOptionalTmpdirToken({
  token,
}: {
  token: string;
  nextToken: string | undefined;
}) {
  if (token !== '--tmpdir') return undefined;
  return {
    kind: 'matched' as const,
    consumeCount: 1,
    effects: [{ key: 'defaultTmpDir', value: true }],
    occurrences: [{
      kind: 'special' as const,
      option: '--tmpdir',
      effects: [{ key: 'defaultTmpDir', value: true }],
    }],
  };
}

function resolveMktempDirectorySelection({
  parsed,
}: {
  parsed: ParsedStandardArgv,
}): {
  tmpDir: string | undefined,
  useDefaultTmpDir: boolean,
} {
  if (parsed.optionValues.deprecatedTmp === true) {
    return { tmpDir: undefined, useDefaultTmpDir: true };
  }

  let tmpDir: string | undefined;
  let useDefaultTmpDir = false;
  for (const occurrence of parsed.occurrences) {
    if (occurrence.kind === 'special' && occurrence.option === '--tmpdir') {
      tmpDir = undefined;
      useDefaultTmpDir = true;
      continue;
    }
    if (occurrence.kind === 'value' && occurrence.key === 'tmpDir') {
      tmpDir = String(occurrence.value);
      useDefaultTmpDir = false;
    }
  }
  return { tmpDir, useDefaultTmpDir };
}

const mktempArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'd', long: 'directory', effects: [{ key: 'directory', value: true }], help: { summary: 'create a directory, not a file', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'value', short: 'p', long: 'tmpdir', key: 'tmpDir', valueName: 'DIR', allowAttachedValue: true, parseValue: undefined, help: { summary: 'interpret TEMPLATE relative to DIR', valueName: 'DIR', category: 'common' } },
    { kind: 'flag', short: 'q', long: 'quiet', effects: [{ key: 'quiet', value: true }], help: { summary: 'suppress diagnostics on failure', category: 'common' } },
    { kind: 'value', short: undefined, long: 'suffix', key: 'suffix', valueName: 'SUFF', allowAttachedValue: true, parseValue: undefined, help: { summary: 'append SUFF to TEMPLATE', valueName: 'SUFF', category: 'advanced' } },
    { kind: 'flag', short: 't', long: undefined, effects: [{ key: 'deprecatedTmp', value: true }], help: { summary: 'interpret TEMPLATE as a single file name component under the temp directory', category: 'advanced' } },
    { kind: 'flag', short: 'u', long: 'dry-run', effects: [{ key: 'dryRun', value: true }], help: { summary: 'print a name without creating anything', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [parseOptionalTmpdirToken],
};

export const mktempCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'mktemp',
    description: 'Create a temporary file or directory',
    usage: 'mktemp [OPTION]... [TEMPLATE]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({
        args: context.args,
        spec: mktempArgvSpec,
        earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
      }),
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
    const directorySelection = resolveMktempDirectorySelection({ parsed });
    const baseDir = resolveMktempBaseDir({
      context,
      tmpDir: directorySelection.tmpDir,
      useDefaultTmpDir: directorySelection.useDefaultTmpDir,
      templateProvided,
    });
    const defaultTemplate = 'tmp.XXXXXXXXXX';
    const rawTemplate = templateInput ?? defaultTemplate;
    const suffix = (parsed.optionValues.suffix as string | undefined) ?? '';

    if ((
      parsed.optionValues.tmpDir !== undefined
      || parsed.optionValues.deprecatedTmp === true
      || parsed.optionValues.defaultTmpDir === true
    ) && rawTemplate.startsWith('/')) {
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
      suffixProvided: parsed.optionValues.suffix !== undefined,
    });
    if (!normalizedTemplate.ok) {
      await context.text().error({ text: `mktemp: ${normalizedTemplate.message}\n` });
      return { exitCode: 1 };
    }

    for (let attempt = 0; attempt < 100; attempt++) {
      const candidatePath = createCandidatePath({
        baseDir: baseDir.resolved,
        displayedBaseDir: baseDir.displayed,
        template: normalizedTemplate.value,
      });

      try {
        if (parsed.optionValues.dryRun === true) {
          await context.text().print({ text: `${candidatePath.displayed}\n` });
          return { exitCode: 0 };
        }

        if (parsed.optionValues.directory === true) {
          await context.files.mkdir({
            path: candidatePath.resolved,
            mode: 0o700,
            recursive: false,
          });
        } else {
          const handle = await context.files.open({
            path: candidatePath.resolved,
            flags: {
              access: 'write',
              creation: 'always',
              truncate: 'preserve',
              append: 'preserve',
            },
            mode: 0o600,
          });
          await handle.close();
        }

        await context.text().print({ text: `${candidatePath.displayed}\n` });
        return { exitCode: 0 };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const alreadyExists = /exist|already/u.test(message);
        if (alreadyExists) {
          continue;
        }

        if (parsed.optionValues.quiet !== true) {
          await context.text().error({ text: `mktemp: failed to create '${candidatePath.displayed}': ${message}\n` });
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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  generateRandomToken,
};
