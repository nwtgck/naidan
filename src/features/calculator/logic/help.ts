import {
  CALCULATOR_CATEGORY_DEFINITIONS,
  getCalculatorFunction,
  isCalculatorFunctionCategory,
  listCalculatorConstants,
  listCalculatorFunctions,
  listCalculatorFunctionsByCategory,
  listCalculatorOperators,
  type CalculatorFunctionDefinition,
} from './catalog';
import { failCalculatorInput } from './diagnostics';
import { CALCULATOR_LIMITS } from './limits';

export type CalculatorHelpResolution =
  | { readonly status: 'not_help' }
  | { readonly status: 'success', readonly topic: string, readonly text: string };

const FIXED_HELP_TOPICS = ['help', 'syntax', 'operators', 'constants', 'precision', 'limits', 'errors', 'all'] as const;

function formatUsage({ definition }: { definition: CalculatorFunctionDefinition }): string {
  const shape = definition.arguments;
  switch (shape.type) {
  case 'exact':
    return `${definition.name}(${shape.names.join(', ')})`;
  case 'variadic': {
    const required = shape.requiredNames.join(', ');
    return `${definition.name}(${required}${required.length === 0 ? '' : ', '}...)`;
  }
  default: {
    const _exhaustive: never = shape;
    throw new Error(`Unhandled calculator argument shape: ${String(_exhaustive)}`);
  }
  }
}

function renderOverview(): string {
  const lines = [
    'Naidan Calculator',
    '',
    'One deterministic numeric expression is evaluated per call.',
    'Use explicit multiplication, such as `2 * pi`.',
    '',
    `Operators: ${listCalculatorOperators().map(definition => definition.symbol).join(' ')}`,
    `Constants: ${listCalculatorConstants().map(definition => definition.name).join(' ')}`,
    '',
    'Functions:',
  ];
  for (const category of CALCULATOR_CATEGORY_DEFINITIONS) {
    const names = listCalculatorFunctionsByCategory({ category: category.name }).map(definition => definition.name);
    lines.push(`  ${category.name}: ${names.join(' ')}`);
  }
  lines.push(
    '',
    'More help:',
    '  help <function>',
    '  help <category>',
    '  help syntax',
    '  help precision',
    '  help limits',
    '  help all',
  );
  return lines.join('\n');
}

function renderFunctionHelp({ definition }: { definition: CalculatorFunctionDefinition }): string {
  const lines = [
    definition.name,
    '',
    `Category: ${definition.category}`,
    `Usage: ${formatUsage({ definition })}`,
    '',
    definition.summary,
  ];
  if (definition.requirements.length > 0) {
    lines.push('', 'Requirements:', ...definition.requirements.map(requirement => `  - ${requirement}`));
  }
  lines.push('', 'Examples:', ...definition.examples.map(example => `  ${example.expression} => ${example.result}`));
  if (definition.related.length > 0) {
    lines.push('', `Related: ${definition.related.join(' ')}`);
  }
  return lines.join('\n');
}

function renderCategoryHelp({ category }: { category: Parameters<typeof listCalculatorFunctionsByCategory>[0]['category'] }): string {
  const categoryDefinition = CALCULATOR_CATEGORY_DEFINITIONS.find(definition => definition.name === category);
  if (categoryDefinition === undefined) throw new Error(`Missing calculator category definition: ${category}`);
  const lines = [categoryDefinition.title, ''];
  for (const definition of listCalculatorFunctionsByCategory({ category })) {
    lines.push(`  ${formatUsage({ definition })}`, `    ${definition.summary}`);
  }
  lines.push('', `Evaluate \`help <function>\` for detailed usage.`);
  return lines.join('\n');
}

function renderFixedHelp({ topic }: { topic: typeof FIXED_HELP_TOPICS[number] }): string {
  switch (topic) {
  case 'help':
    return [
      'Calculator help',
      '',
      '  help                 Show the overview.',
      '  help <function>      Show function usage and examples.',
      '  help <category>      Show a category summary.',
      '  help syntax          Show expression syntax.',
      '  help all             Show all function details.',
    ].join('\n');
  case 'syntax':
    return [
      'Calculator syntax',
      '',
      'Numbers: 12, -3.5, .25, 1e6, 2.5e-3',
      'Operators: + - * / % ^',
      'Grouping: (2 + 3) * 4',
      'Functions: mean(10, 20, 30)',
      'Constants: pi e tau',
      '',
      'Multiplication must be explicit: use `2 * pi`, not `2pi`.',
      '`^` is right-associative: `2 ^ 3 ^ 2` means `2 ^ (3 ^ 2)`.',
      '`-2 ^ 2` means `-(2 ^ 2)`; use `(-2) ^ 2` for a positive result.',
      '`%` is modulo, not percentage syntax.',
    ].join('\n');
  case 'operators':
    return ['Calculator operators', '', ...listCalculatorOperators().map(definition => `  ${definition.symbol} (${definition.associativity}) - ${definition.summary}`)].join('\n');
  case 'constants':
    return ['Calculator constants', '', ...listCalculatorConstants().map(definition => `  ${definition.name} - ${definition.summary}`)].join('\n');
  case 'precision':
    return [
      'Calculator precision',
      '',
      'Calculations use IEEE 754 double-precision numbers.',
      'Displayed non-integer results are rounded to at most 16 significant digits for readability.',
      'Use round_to(value, digits) when explicit decimal rounding is required.',
      'Integer functions require JavaScript safe integers.',
    ].join('\n');
  case 'limits':
    return [
      'Calculator limits',
      '',
      `Input length: ${CALCULATOR_LIMITS.maximumInputLength}`,
      `Tokens: ${CALCULATOR_LIMITS.maximumTokenCount}`,
      `Syntax items: ${CALCULATOR_LIMITS.maximumAstItemCount}`,
      `Syntax depth: ${CALCULATOR_LIMITS.maximumSyntaxDepth}`,
      `Function arguments: ${CALCULATOR_LIMITS.maximumFunctionArgumentCount}`,
      `Operation budget: ${CALCULATOR_LIMITS.maximumOperations}`,
    ].join('\n');
  case 'errors':
    return [
      'Calculator errors',
      '',
      'Errors identify the category, source position, and a correction hint when available.',
      'Common errors include unknown functions, invalid argument counts, domain errors, division by zero, and resource limits.',
    ].join('\n');
  case 'all':
    return [renderOverview(), ...listCalculatorFunctions().map(definition => `\n---\n\n${renderFunctionHelp({ definition })}`)].join('\n');
  default: {
    const _exhaustive: never = topic;
    throw new Error(`Unhandled calculator help topic: ${String(_exhaustive)}`);
  }
  }
}

function getHelpSuggestions({ topic }: { topic: string }): readonly string[] {
  const candidates = [
    ...FIXED_HELP_TOPICS,
    ...CALCULATOR_CATEGORY_DEFINITIONS.map(definition => definition.name),
    ...listCalculatorFunctions().map(definition => definition.name),
  ];
  return candidates
    .filter(candidate => candidate.startsWith(topic) || topic.startsWith(candidate) || candidate.includes(topic) || topic.includes(candidate))
    .slice(0, 5);
}

export function resolveCalculatorHelp({ input }: { input: string }): CalculatorHelpResolution {
  const trimmed = input.trim();
  if (trimmed !== 'help' && !trimmed.startsWith('help ') && !trimmed.startsWith('help\t') && !trimmed.startsWith('help\n') && !trimmed.startsWith('help\r')) {
    return { status: 'not_help' };
  }
  const parts = trimmed.split(/\s+/u);
  if (parts.length === 1) {
    return { status: 'success', topic: 'overview', text: renderOverview() };
  }
  if (parts.length !== 2) {
    failCalculatorInput({
      code: 'invalid_help_usage',
      message: 'Calculator help accepts exactly one topic.',
      span: undefined,
      hint: 'Use `help`, `help <function>`, or `help <category>`.',
    });
  }
  const topic = parts[1]!;
  if ((FIXED_HELP_TOPICS as readonly string[]).includes(topic)) {
    return {
      status: 'success',
      topic,
      text: renderFixedHelp({ topic: topic as typeof FIXED_HELP_TOPICS[number] }),
    };
  }
  if (isCalculatorFunctionCategory(topic)) {
    return { status: 'success', topic, text: renderCategoryHelp({ category: topic }) };
  }
  const functionDefinition = getCalculatorFunction({ name: topic });
  if (functionDefinition !== undefined) {
    return { status: 'success', topic, text: renderFunctionHelp({ definition: functionDefinition }) };
  }
  const suggestions = getHelpSuggestions({ topic });
  failCalculatorInput({
    code: 'unknown_help_topic',
    message: `Unknown calculator help topic: ${topic}.`,
    span: undefined,
    hint: suggestions.length === 0
      ? 'Evaluate `help` to list available topics.'
      : `Related topics: ${suggestions.join(', ')}.`,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  FIXED_HELP_TOPICS,
  formatUsage,
  renderOverview,
};
