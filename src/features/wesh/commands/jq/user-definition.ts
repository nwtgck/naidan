import type { JqFilter, JqUserDefinition } from './ast';
import { transformJqFilter } from './filter-transform';

export type { JqUserParameter } from './ast';

const FILTER_PARAMETER_PREFIX = '\0jq-filter-parameter:';

export function createJqFilterParameterMarker({
  name,
}: {
  name: string,
}): string {
  return `${FILTER_PARAMETER_PREFIX}${name}`;
}

export function substituteJqFilterParameters({
  filter,
  replacements,
}: {
  filter: JqFilter,
  replacements: ReadonlyMap<string, JqFilter>,
}): JqFilter {
  if (replacements.size === 0) return filter;

  const markedReplacements = new Map<string, JqFilter>();
  for (const [name, replacement] of replacements) {
    markedReplacements.set(createJqFilterParameterMarker({ name }), replacement);
  }

  return transformJqFilter({
    filter,
    context: markedReplacements,
    policy: {
      transformVariable: ({ filter: variable, context }) => context.get(variable.name) ?? variable,
      enterVariableScope: ({ name, context }) => ({ name, context }),
    },
  });
}

export function instantiateJqUserDefinition({
  definition,
  args,
}: {
  definition: JqUserDefinition,
  args: readonly JqFilter[],
}): JqFilter {
  if (definition.parameters.length !== args.length) {
    throw new Error('jq: internal user-defined filter argument mismatch');
  }

  const filterReplacements = new Map<string, JqFilter>();
  for (const [index, parameter] of definition.parameters.entries()) {
    const binding = args[index];
    if (binding === undefined) {
      throw new Error('jq: internal user-defined filter argument mismatch');
    }
    switch (parameter.kind) {
    case 'value':
      break;
    case 'filter':
      filterReplacements.set(parameter.name, binding);
      break;
    default: {
      const _ex: never = parameter;
      throw new Error(`Unhandled jq user parameter: ${JSON.stringify(_ex)}`);
    }
    }
  }

  let expanded = substituteJqFilterParameters({
    filter: definition.body,
    replacements: filterReplacements,
  });
  for (let index = definition.parameters.length - 1; index >= 0; index -= 1) {
    const parameter = definition.parameters[index];
    const binding = args[index];
    if (parameter === undefined || binding === undefined) {
      throw new Error('jq: internal user-defined filter argument mismatch');
    }
    switch (parameter.kind) {
    case 'value':
      expanded = { kind: 'bind', binding, name: parameter.name, body: expanded };
      break;
    case 'filter':
      break;
    default: {
      const _ex: never = parameter;
      throw new Error(`Unhandled jq user parameter: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return expanded;
}

export function renameJqDefinitionLocals({
  filter,
  createLocalName,
  initialRenames = new Map(),
}: {
  filter: JqFilter,
  createLocalName: () => string,
  initialRenames?: ReadonlyMap<string, string>,
}): JqFilter {
  return transformJqFilter({
    filter,
    context: initialRenames,
    policy: {
      transformVariable: ({ filter: variable, context }) => {
        const renamed = context.get(variable.name);
        return renamed === undefined ? variable : { kind: 'variable', name: renamed };
      },
      enterVariableScope: ({ name, context }) => {
        const renamedName = createLocalName();
        const scopedRenames = new Map(context);
        scopedRenames.set(name, renamedName);
        return { name: renamedName, context: scopedRenames };
      },
    },
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
