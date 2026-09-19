import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type ParsedStandardArgv, type StandardArgvAction, type StandardArgvPolicy, HELP_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { normalizePath, resolvePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';

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

type MktempDeferredOption = 'tmpdir';

const mktempDirectoryOption = {
  semantic: { kind: 'effects', effects: [{ key: 'directory', value: true }] },
  forms: [
    { kind: 'short', name: 'd', value: { kind: 'none' } },
    { kind: 'long', name: 'directory', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<MktempDeferredOption>>;
const mktempHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<MktempDeferredOption>>;
const mktempTmpdirOption = {
  semantic: { kind: 'deferred', tag: 'tmpdir' },
  forms: [
    { kind: 'short', name: 'p', value: { kind: 'required-attached-or-following', missingValueName: 'DIR' } },
    { kind: 'long', name: 'tmpdir', value: { kind: 'optional-inline' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<MktempDeferredOption>>;
const mktempQuietOption = {
  semantic: { kind: 'effects', effects: [{ key: 'quiet', value: true }] },
  forms: [
    { kind: 'short', name: 'q', value: { kind: 'none' } },
    { kind: 'long', name: 'quiet', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<MktempDeferredOption>>;
const mktempSuffixOption = {
  semantic: { kind: 'required-value', key: 'suffix', parse: undefined },
  forms: [{ kind: 'long', name: 'suffix', value: { kind: 'required', missingValueName: 'SUFF' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<MktempDeferredOption>>;
const mktempDeprecatedTmpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'deprecatedTmp', value: true }] },
  forms: [{ kind: 'short', name: 't', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<MktempDeferredOption>>;
const mktempDryRunOption = {
  semantic: { kind: 'effects', effects: [{ key: 'dryRun', value: true }] },
  forms: [
    { kind: 'short', name: 'u', value: { kind: 'none' } },
    { kind: 'long', name: 'dry-run', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<MktempDeferredOption>>;

const mktempArgvCatalog = defineArgvCatalog<StandardArgvAction<MktempDeferredOption>>({
  nonExecutableLongOptions: ['version'],
  definitions: [
    mktempDirectoryOption, mktempHelpOption, mktempTmpdirOption,
    mktempQuietOption, mktempSuffixOption, mktempDeprecatedTmpOption,
    mktempDryRunOption,
  ],
});
const mktempArgvHelp = defineArgvHelpPresentation({
  catalog: mktempArgvCatalog,
  rows: [
    { forms: mktempDirectoryOption.forms, summary: 'create a directory, not a file', category: 'common' },
    { forms: mktempHelpOption.forms, summary: 'display this help and exit', category: 'common' },
    { forms: mktempTmpdirOption.forms, summary: 'interpret TEMPLATE relative to DIR', valueName: 'DIR', category: 'common' },
    { forms: mktempQuietOption.forms, summary: 'suppress diagnostics on failure', category: 'common' },
    { forms: mktempSuffixOption.forms, summary: 'append SUFF to TEMPLATE', valueName: 'SUFF', category: 'advanced' },
    { forms: mktempDeprecatedTmpOption.forms, summary: 'interpret TEMPLATE as a single file name component under the temp directory', category: 'advanced' },
    { forms: mktempDryRunOption.forms, summary: 'print a name without creating anything', category: 'common' },
  ],
});
const mktempArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

function resolveMktempDirectorySelection({
  parsed,
}: {
  parsed: ParsedStandardArgv<MktempDeferredOption>,
}): {
  tmpDir: string | undefined,
  useDefaultTmpDir: boolean,
  hasTmpDirOption: boolean,
} {
  if (parsed.optionValues.deprecatedTmp === true) {
    return { tmpDir: undefined, useDefaultTmpDir: true, hasTmpDirOption: parsed.deferred.length > 0 };
  }

  let tmpDir: string | undefined;
  let useDefaultTmpDir = false;
  for (const occurrence of parsed.deferred) {
    switch (occurrence.semantic.tag) {
    case 'tmpdir':
      switch (occurrence.value.kind) {
      case 'none':
        tmpDir = undefined;
        useDefaultTmpDir = true;
        break;
      case 'inline':
      case 'next-argv':
        tmpDir = occurrence.value.rawValue;
        useDefaultTmpDir = false;
        break;
      default: {
        const _ex: never = occurrence.value;
        throw new Error(`Unhandled mktemp tmpdir value: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    default: {
      const _ex: never = occurrence.semantic.tag;
      throw new Error(`Unhandled mktemp deferred option: ${_ex}`);
    }
    }
  }
  return { tmpDir, useDefaultTmpDir, hasTmpDirOption: parsed.deferred.length > 0 };
}

export const mktempCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: mktempArgvCatalog,
        policy: mktempArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: mktempArgvCatalog,
      policy: mktempArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'mktemp',
        message: `mktemp: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: mktempArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'mktemp',
        optionLines: formatArgvOptionHelp({ presentation: mktempArgvHelp }),
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 1) {
      await writeCommandUsageError({
        context,
        command: 'mktemp',
        message: 'mktemp: too many templates',
        usageSummary: formatArgvUsageSummary({ presentation: mktempArgvHelp }),
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
      directorySelection.hasTmpDirOption
      || parsed.optionValues.deprecatedTmp === true
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
