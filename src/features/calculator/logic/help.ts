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
  switch (definition.arguments.type) {
  case 'exact':
    return `${definition.name}(${definition.arguments.names.join(', ')})`;
  case 'variadic': {
    const required = definition.arguments.requiredNames.join(', ');
    return `${definition.name}(${required}${required.length === 0 ? '' : ', '}...)`;
  }
  default: {
    const _exhaustive: never = definition.arguments;
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
    `Operators: ${listCalculatorOperators().map(item => item.symbol).join(' ')}`,
    `Constants: ${listCalculatorConstants().map(item => item.name).join(' ')}`,
    '',
    'Functions:',
  ];
  for (const category of CALCULATOR_CATEGORY_DEFINITIONS) {
    lines.push(`  ${category.name}: ${listCalculatorFunctionsByCategory({ category: category.name }).map(item => item.name).join(' ')}`);
  }
  lines.push('', 'More help:', '  help <function>', '  help <category>', '  help syntax', '  help precision', '  help limits', '  help all');
  return lines.join('\n');
}

function renderFunctionHelp({ definition }: { definition: CalculatorFunctionDefinition }): string {
  const lines = [
    definition.name,
    '',
    `Category: ${definition.category}`,
    `Usage: ${formatUsage({ definition })}`,
    `Precision: ${definition.precision}`,
    '',
    definition.summary,
  ];
  if (definition.requirements.length > 0) {
    lines.push('', 'Requirements:', ...definition.requirements.map(item => `  - ${item}`));
  }
  lines.push('', 'Examples:', ...definition.examples.map(item => `  ${item.expression} => ${item.result} (${item.exactness})`));
  if (definition.related.length > 0) lines.push('', `Related: ${definition.related.join(' ')}`);
  return lines.join('\n');
}

function renderCategoryHelp({ category }: {
  category: Parameters<typeof listCalculatorFunctionsByCategory>[0]['category'],
}): string {
  const metadata = CALCULATOR_CATEGORY_DEFINITIONS.find(item => item.name === category);
  if (metadata === undefined) throw new Error(`Missing calculator category definition: ${category}`);
  const lines = [metadata.title, ''];
  for (const definition of listCalculatorFunctionsByCategory({ category })) {
    lines.push(`  ${formatUsage({ definition })}`, `    ${definition.summary}`, `    Precision: ${definition.precision}`);
  }
  lines.push('', 'Evaluate `help <function>` for detailed usage.');
  return lines.join('\n');
}

function renderFixedHelp({ topic }: { topic: typeof FIXED_HELP_TOPICS[number] }): string {
  switch (topic) {
  case 'help':
    return ['Calculator help', '', '  help                 Show the overview.', '  help <function>      Show function usage and examples.', '  help <category>      Show a category summary.', '  help syntax          Show expression syntax.', '  help precision       Show exactness and output rules.', '  help all             Show all function details.'].join('\n');
  case 'syntax':
    return [
      'Calculator syntax', '',
      'Numbers: 12, -3.5, .25, 1e6, 2.5e-3',
      'Operators: + - * / % ^',
      'Grouping: (2 + 3) * 4',
      'Functions: mean(10, 20, 30)',
      'Constants: pi e tau', '',
      'Multiplication must be explicit: use `2 * pi`, not `2pi`.',
      '`^` is right-associative: `2 ^ 3 ^ 2` means `2 ^ (3 ^ 2)`.',
      '`-2 ^ 2` means `-(2 ^ 2)`; use `(-2) ^ 2` for a positive result.',
      '`^` and pow require an exact integer exponent.',
      '`%` is exact Euclidean modulo, not JavaScript remainder or percentage syntax.',
      'The modulo divisor must be greater than zero.',
    ].join('\n');
  case 'operators':
    return ['Calculator operators', '', ...listCalculatorOperators().map(item => `  ${item.symbol} (${item.associativity}) - ${item.summary}`)].join('\n');
  case 'constants':
    return ['Calculator constants', '', ...listCalculatorConstants().map(item => `  ${item.name} (${item.precision}) - ${item.summary}`)].join('\n');
  case 'precision':
    return [
      'Calculator precision', '',
      'Finite decimal literals and rational arithmetic are preserved exactly within resource limits.',
      'Examples: `0.1 + 0.2` is exactly 0.3, and `1 / 3` is retained internally as the rational value 1/3.',
      `Approximate values use a bounded ${CALCULATOR_LIMITS.workingSignificantDigits}-significant-digit decimal working context.`,
      'Constants pi, e, and tau, and irrational roots such as sqrt(2), are approximate.',
      'Compound approximate expressions are not guaranteed to be correctly rounded from the exact mathematical value.', '',
      `Decimal Tool output defaults to ${CALCULATOR_LIMITS.defaultToolSignificantDigits} significant digits and supports at most ${CALCULATOR_LIMITS.maximumResultSignificantDigits}.`,
      'Rational Tool output preserves exact fractions such as 1/3 and rejects approximate results such as pi * 2.',
      'Use round_to(value, decimal_places) when rounding is part of the expression itself.',
    ].join('\n');
  case 'limits':
    return [
      'Calculator limits', '',
      `Input length: ${CALCULATOR_LIMITS.maximumInputLength}`,
      `Tokens: ${CALCULATOR_LIMITS.maximumTokenCount}`,
      `Syntax items: ${CALCULATOR_LIMITS.maximumAstItemCount}`,
      `Syntax depth: ${CALCULATOR_LIMITS.maximumSyntaxDepth}`,
      `Function arguments: ${CALCULATOR_LIMITS.maximumFunctionArgumentCount}`,
      `Evaluation operation budget: ${CALCULATOR_LIMITS.maximumOperations}`,
      `Internal numeric iterations per bounded algorithm: ${CALCULATOR_LIMITS.maximumInternalNumericIterations}`,
      `Coefficient digits: ${CALCULATOR_LIMITS.maximumCoefficientDigits}`,
      `Denominator digits: ${CALCULATOR_LIMITS.maximumDenominatorDigits}`,
      `Decimal exponent magnitude: ${CALCULATOR_LIMITS.maximumExponentMagnitude}`,
      `Decimal alignment digits: ${CALCULATOR_LIMITS.maximumAlignmentDigits}`,
      `Materialized integer digits: ${CALCULATOR_LIMITS.maximumMaterializedIntegerDigits}`,
      `Numeric result output length: ${CALCULATOR_LIMITS.maximumOutputLength}`,
    ].join('\n');
  case 'errors':
    return ['Calculator errors', '', 'Errors identify the category, source position, and a correction hint when available.', 'Common errors include unknown functions, invalid arguments, domain errors, division by zero, non-rational output requests, and resource limits.'].join('\n');
  case 'all':
    return [renderOverview(), ...listCalculatorFunctions().map(item => `\n---\n\n${renderFunctionHelp({ definition: item })}`)].join('\n');
  default: {
    const _exhaustive: never = topic;
    throw new Error(`Unhandled calculator help topic: ${String(_exhaustive)}`);
  }
  }
}

function getHelpSuggestions({ topic }: { topic: string }): readonly string[] {
  return [
    ...FIXED_HELP_TOPICS,
    ...CALCULATOR_CATEGORY_DEFINITIONS.map(item => item.name),
    ...listCalculatorFunctions().map(item => item.name),
  ].filter(candidate => candidate.startsWith(topic)
      || topic.startsWith(candidate)
      || candidate.includes(topic)
      || topic.includes(candidate))
    .slice(0, 5);
}

export function resolveCalculatorHelp({ input }: { input: string }): CalculatorHelpResolution {
  const trimmed = input.trim();
  if (trimmed !== 'help' && !/^help\s/u.test(trimmed)) return { status: 'not_help' };
  const parts = trimmed.split(/\s+/u);
  if (parts.length === 1) return { status: 'success', topic: 'overview', text: renderOverview() };
  if (parts.length !== 2) {
    return failCalculatorInput({
      code: 'invalid_help_usage', message: 'Calculator help accepts exactly one topic.', span: undefined,
      hint: 'Evaluate `help` to see all available topics.',
    });
  }
  const topic = parts[1]!;
  if ((FIXED_HELP_TOPICS as readonly string[]).includes(topic)) {
    return { status: 'success', topic, text: renderFixedHelp({ topic: topic as typeof FIXED_HELP_TOPICS[number] }) };
  }
  if (isCalculatorFunctionCategory(topic)) return { status: 'success', topic, text: renderCategoryHelp({ category: topic }) };
  const definition = getCalculatorFunction({ name: topic });
  if (definition !== undefined) return { status: 'success', topic, text: renderFunctionHelp({ definition }) };
  const suggestions = getHelpSuggestions({ topic });
  return failCalculatorInput({
    code: 'unknown_help_topic', message: `Unknown calculator help topic: ${topic}`, span: undefined,
    hint: suggestions.length === 0 ? 'Evaluate `help` to see all available topics.' : `Related topics: ${suggestions.join(', ')}`,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = { formatUsage, renderOverview };
