import type { ArgvSyntaxForm, CatalogArgvHelpPresentation, CatalogArgvHelpRow } from './catalog';

interface ArgvHelpDisplayRow {
  readonly label: string,
  readonly summary: string,
  readonly category: 'common' | 'advanced' | undefined,
}

function getHelpCategoryRank({ category }: { category: 'common' | 'advanced' | undefined }): number {
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

function formatArgvOptionForm({
  form,
  valueName,
}: {
  form: ArgvSyntaxForm,
  valueName: string | undefined,
}): string {
  const formatShort = ({ prefix }: { prefix: '-' | '+' }): string => {
    if (form.kind !== 'short' && form.kind !== 'plus-short') {
      throw new Error('Internal argv help invariant violated: expected a short form');
    }
    switch (form.value.kind) {
    case 'none':
      return `${prefix}${form.name}`;
    case 'required-attached-or-following':
      return `${prefix}${form.name} ${valueName ?? form.value.missingValueName}`;
    case 'optional-following':
      return valueName === undefined ? `${prefix}${form.name}` : `${prefix}${form.name} [${valueName}]`;
    case 'optional-attached':
      return valueName === undefined ? `${prefix}${form.name}` : `${prefix}${form.name}[${valueName}]`;
    default: {
      const _ex: never = form.value;
      throw new Error(`Unhandled short argv value syntax: ${JSON.stringify(_ex)}`);
    }
    }
  };

  switch (form.kind) {
  case 'short':
    return formatShort({ prefix: '-' });
  case 'plus-short':
    return formatShort({ prefix: '+' });
  case 'long':
    switch (form.value.kind) {
    case 'none':
      return `--${form.name}`;
    case 'required':
      return `--${form.name}=${valueName ?? form.value.missingValueName}`;
    case 'optional-inline':
      return valueName === undefined ? `--${form.name}` : `--${form.name}[=${valueName}]`;
    default: {
      const _ex: never = form.value;
      throw new Error(`Unhandled long argv value syntax: ${JSON.stringify(_ex)}`);
    }
    }
  default: {
    const _ex: never = form;
    throw new Error(`Unhandled argv syntax form: ${JSON.stringify(_ex)}`);
  }
  }
}

function toDisplayRow({ row }: { row: CatalogArgvHelpRow }): ArgvHelpDisplayRow {
  return {
    label: row.forms.map((form) => formatArgvOptionForm({ form, valueName: row.valueName })).join(', '),
    summary: row.summary,
    category: row.category,
  };
}

function sortHelpRows({ rows }: { rows: readonly CatalogArgvHelpRow[] }): CatalogArgvHelpRow[] {
  return [...rows].sort((left, right) => getHelpCategoryRank({ category: left.category }) - getHelpCategoryRank({ category: right.category }));
}

export function formatArgvUsageSummary({
  presentation,
}: {
  presentation: CatalogArgvHelpPresentation,
}): string {
  const hasLongHelp = ({ row }: { row: CatalogArgvHelpRow }): boolean =>
    row.forms.some((form) => form.kind === 'long' && form.name === 'help');
  const sortedRows = sortHelpRows({ rows: presentation.rows });
  const rows = sortedRows.slice(0, 12);
  const options = rows
    .map((row) => toDisplayRow({ row }).label)
    .filter((label) => label.length > 0);
  const hasHelp = sortedRows.some((row) => hasLongHelp({ row }));
  const includesHelp = rows.some((row) => hasLongHelp({ row }));
  return `try: ${(hasHelp && !includesHelp ? [...options, '--help'] : options).join(', ')}`;
}

export function formatArgvOptionHelp({
  presentation,
}: {
  presentation: CatalogArgvHelpPresentation,
}): string[] {
  return sortHelpRows({ rows: presentation.rows })
    .map((row) => toDisplayRow({ row }))
    .map((row) => `  ${row.label.padEnd(28, ' ')} ${row.summary}`.trimEnd());
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
