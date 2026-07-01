import { AGGREGATION_CALCULATOR_FUNCTIONS } from './aggregation-functions';
import { BASIC_CALCULATOR_FUNCTIONS } from './basic-functions';
import { CALCULATOR_CONSTANT_DEFINITIONS } from './constants';
import { INTEGER_CALCULATOR_FUNCTIONS } from './integer-functions';
import { CALCULATOR_OPERATOR_DEFINITIONS } from './operators';
import { TRANSCENDENTAL_CALCULATOR_FUNCTIONS } from './transcendental-functions';
import type {
  CalculatorConstantDefinition,
  CalculatorFunctionCategory,
  CalculatorFunctionDefinition,
  CalculatorOperatorDefinition,
} from './types';

export type {
  CalculatorArgumentShape,
  CalculatorFunctionCategory,
  CalculatorFunctionDefinition,
  CalculatorRuntime,
} from './types';

export const CALCULATOR_CATEGORY_DEFINITIONS = [
  { name: 'arithmetic', title: 'Arithmetic' },
  { name: 'powers', title: 'Powers and roots' },
  { name: 'rounding', title: 'Rounding' },
  { name: 'logarithms', title: 'Exponential and logarithmic' },
  { name: 'trigonometry', title: 'Trigonometry' },
  { name: 'aggregation', title: 'Aggregation' },
  { name: 'percentages', title: 'Percentages' },
  { name: 'integers', title: 'Integer functions' },
] as const satisfies readonly {
  readonly name: CalculatorFunctionCategory,
  readonly title: string,
}[];

const allFunctions: readonly CalculatorFunctionDefinition[] = [
  ...BASIC_CALCULATOR_FUNCTIONS,
  ...TRANSCENDENTAL_CALCULATOR_FUNCTIONS,
  ...AGGREGATION_CALCULATOR_FUNCTIONS,
  ...INTEGER_CALCULATOR_FUNCTIONS,
];

const functionsByName = new Map<string, CalculatorFunctionDefinition>();
const constantsByName = new Map<string, CalculatorConstantDefinition>();
const categories = new Set<CalculatorFunctionCategory>(CALCULATOR_CATEGORY_DEFINITIONS.map(definition => definition.name));
const identifierPattern = /^[a-z][a-z0-9_]*$/;

for (const definition of CALCULATOR_CONSTANT_DEFINITIONS) {
  if (!identifierPattern.test(definition.name)) throw new Error(`Invalid calculator constant name: ${definition.name}`);
  if (constantsByName.has(definition.name)) throw new Error(`Duplicate calculator constant: ${definition.name}`);
  constantsByName.set(definition.name, definition);
}
for (const definition of allFunctions) {
  if (!identifierPattern.test(definition.name)) throw new Error(`Invalid calculator function name: ${definition.name}`);
  if (!categories.has(definition.category)) throw new Error(`Unknown calculator category: ${definition.category}`);
  if (functionsByName.has(definition.name)) throw new Error(`Duplicate calculator function: ${definition.name}`);
  if (constantsByName.has(definition.name)) throw new Error(`Calculator function conflicts with constant: ${definition.name}`);
  if (definition.examples.length === 0) throw new Error(`Calculator function lacks an example: ${definition.name}`);
  if (definition.arguments.type === 'variadic' && definition.arguments.requiredNames.length > definition.arguments.maximumCount) {
    throw new Error(`Invalid variadic calculator arity: ${definition.name}`);
  }
  functionsByName.set(definition.name, definition);
}
for (const definition of allFunctions) {
  for (const related of definition.related) {
    if (!functionsByName.has(related)) throw new Error(`Unknown related calculator function ${related} in ${definition.name}`);
  }
}

export function getCalculatorFunction({ name }: { name: string }): CalculatorFunctionDefinition | undefined {
  return functionsByName.get(name);
}

export function getCalculatorConstant({ name }: { name: string }): CalculatorConstantDefinition | undefined {
  return constantsByName.get(name);
}

export function listCalculatorFunctions(): readonly CalculatorFunctionDefinition[] {
  return allFunctions;
}

export function listCalculatorConstants(): readonly CalculatorConstantDefinition[] {
  return CALCULATOR_CONSTANT_DEFINITIONS;
}

export function listCalculatorOperators(): readonly CalculatorOperatorDefinition[] {
  return CALCULATOR_OPERATOR_DEFINITIONS;
}

export function listCalculatorFunctionsByCategory({ category }: {
  category: CalculatorFunctionCategory,
}): readonly CalculatorFunctionDefinition[] {
  return allFunctions.filter(definition => definition.category === category);
}

export function isCalculatorFunctionCategory(value: string): value is CalculatorFunctionCategory {
  return categories.has(value as CalculatorFunctionCategory);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  functionsByName,
  constantsByName,
};
