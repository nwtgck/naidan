import type { ArgvOptionSpec, StandardArgvParserSpec } from './types';

function getHelpCategoryRank(category: 'common' | 'advanced' | undefined): number {
  switch (category) {
  case 'common':
    return 0;
  case 'advanced':
  case undefined:
    return 1;
  default: {
    const _ex: never = category;
    throw new Error(`Unhandled option help category: ${_ex}`);
  }
  }
}

function formatOptionLabel({ option }: { option: ArgvOptionSpec }): string {
  const names: string[] = [];

  if (option.short !== undefined) {
    const shortName = (() => {
      switch (option.kind) {
      case 'flag':
        return `-${option.short}`;
      case 'value':
        return `-${option.short} ${option.help?.valueName ?? option.valueName}`;
      default: {
        const _ex: never = option;
        throw new Error(`Unhandled option kind: ${_ex}`);
      }
      }
    })();
    names.push(shortName);
  }

  if (option.long !== undefined) {
    const longName = (() => {
      switch (option.kind) {
      case 'flag':
        return `--${option.long}`;
      case 'value':
        return `--${option.long}=${option.help?.valueName ?? option.valueName}`;
      default: {
        const _ex: never = option;
        throw new Error(`Unhandled option kind: ${_ex}`);
      }
      }
    })();
    names.push(longName);
  }

  return names.join(', ');
}

export function formatArgvUsageSummary({
  spec,
  maxOptions = 12,
  includeHelpHint = true,
}: {
  spec: StandardArgvParserSpec;
  maxOptions?: number;
  includeHelpHint?: boolean;
}): string | undefined {
  const options = spec.options
    .filter((option) => option.help !== undefined)
    .sort((left, right) => {
      const leftCategory = getHelpCategoryRank(left.help?.category);
      const rightCategory = getHelpCategoryRank(right.help?.category);
      return leftCategory - rightCategory;
    })
    .slice(0, maxOptions)
    .map((option) => formatOptionLabel({ option }))
    .filter((label) => label.length > 0);

  if (options.length === 0) {
    return includeHelpHint ? 'try: --help' : undefined;
  }

  const parts = includeHelpHint ? [...options, '--help'] : options;
  return `try: ${parts.join(', ')}`;
}

export function formatArgvOptionHelp({
  spec,
  maxOptions,
}: {
  spec: StandardArgvParserSpec;
  maxOptions?: number;
}): string[] {
  const options = spec.options
    .filter((option) => option.help !== undefined)
    .sort((left, right) => {
      const leftCategory = getHelpCategoryRank(left.help?.category);
      const rightCategory = getHelpCategoryRank(right.help?.category);
      return leftCategory - rightCategory;
    });

  const limitedOptions = maxOptions === undefined ? options : options.slice(0, maxOptions);
  return limitedOptions.map((option) => {
    const label = formatOptionLabel({ option }).padEnd(28, ' ');
    return `  ${label} ${option.help?.summary ?? ''}`.trimEnd();
  });
}
