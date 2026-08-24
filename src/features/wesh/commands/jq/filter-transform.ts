import type {
  JqFilter,
  JqObjectEntry,
  JqPathExpression,
  JqStringPart,
} from './ast';

export interface JqFilterTransformPolicy<Context> {
  readonly transformVariable: ({
    filter,
    context,
  }: {
    filter: Extract<JqFilter, { kind: 'variable' }>,
    context: Context,
  }) => JqFilter,
  readonly enterVariableScope: ({
    name,
    context,
  }: {
    name: string,
    context: Context,
  }) => {
    readonly name: string,
    readonly context: Context,
  },
}

type TransformTask<Context> =
  | { readonly kind: 'visit_filter', readonly filter: JqFilter, readonly context: Context }
  | {
    readonly kind: 'rebuild_filter',
    readonly filter: JqFilter,
    readonly scopedName: string | undefined,
  }
  | { readonly kind: 'visit_path', readonly expression: JqPathExpression, readonly context: Context }
  | { readonly kind: 'rebuild_path', readonly expression: JqPathExpression };

function popFilterResults({
  results,
  count,
}: {
  results: JqFilter[],
  count: number,
}): JqFilter[] {
  if (results.length < count) {
    throw new Error('jq filter transform result stack is incomplete');
  }
  return results.splice(results.length - count, count);
}

function popPathResults({
  results,
  count,
}: {
  results: JqPathExpression[],
  count: number,
}): JqPathExpression[] {
  if (results.length < count) {
    throw new Error('jq path transform result stack is incomplete');
  }
  return results.splice(results.length - count, count);
}

function pushFilterTasks<Context>({
  tasks,
  children,
}: {
  tasks: TransformTask<Context>[],
  children: readonly {
    readonly filter: JqFilter,
    readonly context: Context,
  }[],
}): void {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child === undefined) throw new Error('jq filter transform child is missing');
    tasks.push({ kind: 'visit_filter', filter: child.filter, context: child.context });
  }
}

function pushPathTasks<Context>({
  tasks,
  children,
}: {
  tasks: TransformTask<Context>[],
  children: readonly {
    readonly expression: JqPathExpression,
    readonly context: Context,
  }[],
}): void {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child === undefined) throw new Error('jq path transform child is missing');
    tasks.push({ kind: 'visit_path', expression: child.expression, context: child.context });
  }
}

export function transformJqFilter<Context>({
  filter,
  context,
  policy,
}: {
  filter: JqFilter,
  context: Context,
  policy: JqFilterTransformPolicy<Context>,
}): JqFilter {
  const tasks: TransformTask<Context>[] = [{ kind: 'visit_filter', filter, context }];
  const filterResults: JqFilter[] = [];
  const pathResults: JqPathExpression[] = [];

  while (tasks.length > 0) {
    const task = tasks.pop();
    if (task === undefined) throw new Error('jq filter transform task stack is empty');

    switch (task.kind) {
    case 'visit_filter': {
      const current = task.filter;
      switch (current.kind) {
      case 'identity':
      case 'literal':
      case 'break':
        filterResults.push(current);
        break;
      case 'variable':
        filterResults.push(policy.transformVariable({ filter: current, context: task.context }));
        break;
      case 'string': {
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        const children: { readonly filter: JqFilter, readonly context: Context }[] = [];
        for (const part of current.parts) {
          switch (part.kind) {
          case 'text':
            break;
          case 'interpolation':
            children.push({ filter: part.filter, context: task.context });
            break;
          default: {
            const _ex: never = part;
            throw new Error(`Unhandled jq string part: ${JSON.stringify(_ex)}`);
          }
          }
        }
        pushFilterTasks({ tasks, children });
        break;
      }
      case 'array':
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        pushFilterTasks({
          tasks,
          children: current.items.map((item) => ({ filter: item, context: task.context })),
        });
        break;
      case 'object': {
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        const children: { readonly filter: JqFilter, readonly context: Context }[] = [];
        for (const entry of current.entries) {
          switch (entry.key.kind) {
          case 'static':
            break;
          case 'dynamic':
            children.push({ filter: entry.key.filter, context: task.context });
            break;
          default: {
            const _ex: never = entry.key;
            throw new Error(`Unhandled jq object key: ${JSON.stringify(_ex)}`);
          }
          }
          children.push({ filter: entry.value, context: task.context });
        }
        pushFilterTasks({ tasks, children });
        break;
      }
      case 'field':
      case 'index':
      case 'iterate':
      case 'recursive_descent':
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        pushFilterTasks({
          tasks,
          children: [{ filter: current.input, context: task.context }],
        });
        break;
      case 'dynamic_index':
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        pushFilterTasks({
          tasks,
          children: [
            { filter: current.input, context: task.context },
            { filter: current.index, context: task.context },
          ],
        });
        break;
      case 'slice': {
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        const children = [{ filter: current.input, context: task.context }];
        if (current.start !== undefined) children.push({ filter: current.start, context: task.context });
        if (current.end !== undefined) children.push({ filter: current.end, context: task.context });
        pushFilterTasks({ tasks, children });
        break;
      }
      case 'optional':
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        pushFilterTasks({ tasks, children: [{ filter: current.body, context: task.context }] });
        break;
      case 'pipe':
      case 'comma':
      case 'binary':
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        pushFilterTasks({
          tasks,
          children: [
            { filter: current.left, context: task.context },
            { filter: current.right, context: task.context },
          ],
        });
        break;
      case 'conditional':
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        pushFilterTasks({
          tasks,
          children: [
            { filter: current.condition, context: task.context },
            { filter: current.thenBranch, context: task.context },
            { filter: current.elseBranch, context: task.context },
          ],
        });
        break;
      case 'trycatch':
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        pushFilterTasks({
          tasks,
          children: [
            { filter: current.body, context: task.context },
            { filter: current.catchBranch, context: task.context },
          ],
        });
        break;
      case 'call':
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        pushFilterTasks({
          tasks,
          children: current.args.map((arg) => ({ filter: arg, context: task.context })),
        });
        break;
      case 'user_call':
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        pushFilterTasks({
          tasks,
          children: current.args.map((arg) => ({ filter: arg, context: task.context })),
        });
        break;
      case 'unresolved_user_call':
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        pushFilterTasks({
          tasks,
          children: current.args.map((arg) => ({ filter: arg, context: task.context })),
        });
        break;
      case 'unary':
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        pushFilterTasks({ tasks, children: [{ filter: current.value, context: task.context }] });
        break;
      case 'label':
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        pushFilterTasks({ tasks, children: [{ filter: current.body, context: task.context }] });
        break;
      case 'bind': {
        const scope = policy.enterVariableScope({ name: current.name, context: task.context });
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: scope.name });
        pushFilterTasks({
          tasks,
          children: [
            { filter: current.binding, context: task.context },
            { filter: current.body, context: scope.context },
          ],
        });
        break;
      }
      case 'reduce': {
        const scope = policy.enterVariableScope({ name: current.name, context: task.context });
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: scope.name });
        pushFilterTasks({
          tasks,
          children: [
            { filter: current.generator, context: task.context },
            { filter: current.initial, context: task.context },
            { filter: current.update, context: scope.context },
          ],
        });
        break;
      }
      case 'foreach': {
        const scope = policy.enterVariableScope({ name: current.name, context: task.context });
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: scope.name });
        pushFilterTasks({
          tasks,
          children: [
            { filter: current.generator, context: task.context },
            { filter: current.initial, context: task.context },
            { filter: current.update, context: scope.context },
            { filter: current.extract, context: scope.context },
          ],
        });
        break;
      }
      case 'assign':
      case 'update':
        tasks.push({ kind: 'rebuild_filter', filter: current, scopedName: undefined });
        pushFilterTasks({ tasks, children: [{ filter: current.value, context: task.context }] });
        pushPathTasks({ tasks, children: [{ expression: current.pathExpression, context: task.context }] });
        break;
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled jq filter: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    case 'rebuild_filter': {
      const current = task.filter;
      switch (current.kind) {
      case 'string': {
        let interpolationCount = 0;
        for (const part of current.parts) {
          switch (part.kind) {
          case 'text':
            break;
          case 'interpolation':
            interpolationCount += 1;
            break;
          default: {
            const _ex: never = part;
            throw new Error(`Unhandled jq string part: ${JSON.stringify(_ex)}`);
          }
          }
        }
        const transformed = popFilterResults({
          results: filterResults,
          count: interpolationCount,
        });
        let nextFilter = 0;
        const parts: JqStringPart[] = [];
        for (const part of current.parts) {
          switch (part.kind) {
          case 'text':
            parts.push(part);
            break;
          case 'interpolation': {
            const replacement = transformed[nextFilter];
            nextFilter += 1;
            if (replacement === undefined) throw new Error('jq string transform result is missing');
            parts.push({ kind: 'interpolation', filter: replacement });
            break;
          }
          default: {
            const _ex: never = part;
            throw new Error(`Unhandled jq string part: ${JSON.stringify(_ex)}`);
          }
          }
        }
        filterResults.push({ kind: 'string', parts });
        break;
      }
      case 'array':
        filterResults.push({
          kind: 'array',
          items: popFilterResults({ results: filterResults, count: current.items.length }),
        });
        break;
      case 'object': {
        let childCount = 0;
        for (const entry of current.entries) {
          switch (entry.key.kind) {
          case 'static':
            childCount += 1;
            break;
          case 'dynamic':
            childCount += 2;
            break;
          default: {
            const _ex: never = entry.key;
            throw new Error(`Unhandled jq object key: ${JSON.stringify(_ex)}`);
          }
          }
        }
        const transformed = popFilterResults({ results: filterResults, count: childCount });
        let nextFilter = 0;
        const entries: JqObjectEntry[] = [];
        for (const entry of current.entries) {
          let key: JqObjectEntry['key'];
          switch (entry.key.kind) {
          case 'static':
            key = entry.key;
            break;
          case 'dynamic': {
            const filter = transformed[nextFilter];
            nextFilter += 1;
            if (filter === undefined) throw new Error('jq object key transform result is missing');
            key = { kind: 'dynamic', filter };
            break;
          }
          default: {
            const _ex: never = entry.key;
            throw new Error(`Unhandled jq object key: ${JSON.stringify(_ex)}`);
          }
          }
          const value = transformed[nextFilter];
          nextFilter += 1;
          if (value === undefined) throw new Error('jq object transform result is missing');
          entries.push({ key, value });
        }
        filterResults.push({ kind: 'object', entries });
        break;
      }
      case 'field': {
        const [input] = popFilterResults({ results: filterResults, count: 1 });
        if (input === undefined) throw new Error('jq field transform result is missing');
        filterResults.push({ ...current, input });
        break;
      }
      case 'index': {
        const [input] = popFilterResults({ results: filterResults, count: 1 });
        if (input === undefined) throw new Error('jq index transform result is missing');
        filterResults.push({ ...current, input });
        break;
      }
      case 'iterate': {
        const [input] = popFilterResults({ results: filterResults, count: 1 });
        if (input === undefined) throw new Error('jq iterate transform result is missing');
        filterResults.push({ ...current, input });
        break;
      }
      case 'recursive_descent': {
        const [input] = popFilterResults({ results: filterResults, count: 1 });
        if (input === undefined) throw new Error('jq recursive descent transform result is missing');
        filterResults.push({ ...current, input });
        break;
      }
      case 'dynamic_index': {
        const [input, index] = popFilterResults({ results: filterResults, count: 2 });
        if (input === undefined || index === undefined) throw new Error('jq dynamic index transform result is missing');
        filterResults.push({ ...current, input, index });
        break;
      }
      case 'slice': {
        const childCount = 1 + (current.start === undefined ? 0 : 1) + (current.end === undefined ? 0 : 1);
        const transformed = popFilterResults({ results: filterResults, count: childCount });
        let nextFilter = 0;
        const input = transformed[nextFilter++];
        if (input === undefined) throw new Error('jq slice transform input is missing');
        const start = current.start === undefined ? undefined : transformed[nextFilter++];
        const end = current.end === undefined ? undefined : transformed[nextFilter++];
        filterResults.push({ ...current, input, start, end });
        break;
      }
      case 'optional': {
        const [body] = popFilterResults({ results: filterResults, count: 1 });
        if (body === undefined) throw new Error('jq optional transform result is missing');
        filterResults.push({ kind: 'optional', body });
        break;
      }
      case 'pipe':
      case 'comma':
      case 'binary': {
        const [left, right] = popFilterResults({ results: filterResults, count: 2 });
        if (left === undefined || right === undefined) throw new Error('jq binary transform result is missing');
        filterResults.push({ ...current, left, right });
        break;
      }
      case 'conditional': {
        const [condition, thenBranch, elseBranch] = popFilterResults({ results: filterResults, count: 3 });
        if (condition === undefined || thenBranch === undefined || elseBranch === undefined) {
          throw new Error('jq conditional transform result is missing');
        }
        filterResults.push({ kind: 'conditional', condition, thenBranch, elseBranch });
        break;
      }
      case 'trycatch': {
        const [body, catchBranch] = popFilterResults({ results: filterResults, count: 2 });
        if (body === undefined || catchBranch === undefined) throw new Error('jq try/catch transform result is missing');
        filterResults.push({ kind: 'trycatch', body, catchBranch });
        break;
      }
      case 'call':
        filterResults.push({
          ...current,
          args: popFilterResults({ results: filterResults, count: current.args.length }),
        });
        break;
      case 'user_call':
        filterResults.push({
          ...current,
          args: popFilterResults({ results: filterResults, count: current.args.length }),
        });
        break;
      case 'unresolved_user_call':
        filterResults.push({
          ...current,
          args: popFilterResults({ results: filterResults, count: current.args.length }),
        });
        break;
      case 'unary': {
        const [value] = popFilterResults({ results: filterResults, count: 1 });
        if (value === undefined) throw new Error('jq unary transform result is missing');
        filterResults.push({ ...current, value });
        break;
      }
      case 'label': {
        const [body] = popFilterResults({ results: filterResults, count: 1 });
        if (body === undefined) throw new Error('jq label transform result is missing');
        filterResults.push({ ...current, body });
        break;
      }
      case 'bind': {
        const [binding, body] = popFilterResults({ results: filterResults, count: 2 });
        if (binding === undefined || body === undefined || task.scopedName === undefined) {
          throw new Error('jq binding transform result is missing');
        }
        filterResults.push({ kind: 'bind', binding, name: task.scopedName, body });
        break;
      }
      case 'reduce': {
        const [generator, initial, update] = popFilterResults({ results: filterResults, count: 3 });
        if (generator === undefined || initial === undefined || update === undefined || task.scopedName === undefined) {
          throw new Error('jq reduce transform result is missing');
        }
        filterResults.push({ kind: 'reduce', generator, name: task.scopedName, initial, update });
        break;
      }
      case 'foreach': {
        const [generator, initial, update, extract] = popFilterResults({ results: filterResults, count: 4 });
        if (
          generator === undefined
          || initial === undefined
          || update === undefined
          || extract === undefined
          || task.scopedName === undefined
        ) {
          throw new Error('jq foreach transform result is missing');
        }
        filterResults.push({ kind: 'foreach', generator, name: task.scopedName, initial, update, extract });
        break;
      }
      case 'assign':
      case 'update': {
        const [pathExpression] = popPathResults({ results: pathResults, count: 1 });
        const [value] = popFilterResults({ results: filterResults, count: 1 });
        if (pathExpression === undefined || value === undefined) throw new Error('jq assignment transform result is missing');
        filterResults.push({ ...current, pathExpression, value });
        break;
      }
      case 'identity':
      case 'variable':
      case 'literal':
      case 'break':
        throw new Error(`Unexpected jq leaf rebuild task: ${current.kind}`);
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled jq filter rebuild: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    case 'visit_path': {
      const current = task.expression;
      switch (current.kind) {
      case 'path':
        pathResults.push(current);
        break;
      case 'sequence':
        tasks.push({ kind: 'rebuild_path', expression: current });
        pushPathTasks({
          tasks,
          children: current.items.map((item) => ({ expression: item, context: task.context })),
        });
        break;
      case 'append':
      case 'iterate':
        tasks.push({ kind: 'rebuild_path', expression: current });
        pushPathTasks({ tasks, children: [{ expression: current.parent, context: task.context }] });
        break;
      case 'dynamic_index':
        tasks.push({ kind: 'rebuild_path', expression: current });
        pushFilterTasks({ tasks, children: [{ filter: current.index, context: task.context }] });
        pushPathTasks({ tasks, children: [{ expression: current.parent, context: task.context }] });
        break;
      case 'dynamic_slice': {
        tasks.push({ kind: 'rebuild_path', expression: current });
        const filters: { readonly filter: JqFilter, readonly context: Context }[] = [];
        if (current.start !== undefined) filters.push({ filter: current.start, context: task.context });
        if (current.end !== undefined) filters.push({ filter: current.end, context: task.context });
        pushFilterTasks({ tasks, children: filters });
        pushPathTasks({ tasks, children: [{ expression: current.parent, context: task.context }] });
        break;
      }
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled jq path expression: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    case 'rebuild_path': {
      const current = task.expression;
      switch (current.kind) {
      case 'sequence':
        pathResults.push({
          kind: 'sequence',
          items: popPathResults({ results: pathResults, count: current.items.length }),
        });
        break;
      case 'append': {
        const [parent] = popPathResults({ results: pathResults, count: 1 });
        if (parent === undefined) throw new Error('jq append path transform result is missing');
        pathResults.push({ kind: 'append', parent, segment: current.segment });
        break;
      }
      case 'iterate': {
        const [parent] = popPathResults({ results: pathResults, count: 1 });
        if (parent === undefined) throw new Error('jq iterate path transform result is missing');
        pathResults.push({ kind: 'iterate', parent, optional: current.optional });
        break;
      }
      case 'dynamic_index': {
        const [parent] = popPathResults({ results: pathResults, count: 1 });
        const [index] = popFilterResults({ results: filterResults, count: 1 });
        if (parent === undefined || index === undefined) throw new Error('jq dynamic path transform result is missing');
        pathResults.push({ ...current, parent, index });
        break;
      }
      case 'dynamic_slice': {
        const [parent] = popPathResults({ results: pathResults, count: 1 });
        if (parent === undefined) throw new Error('jq dynamic slice path parent is missing');
        const childCount = (current.start === undefined ? 0 : 1) + (current.end === undefined ? 0 : 1);
        const transformed = popFilterResults({ results: filterResults, count: childCount });
        let nextFilter = 0;
        const start = current.start === undefined ? undefined : transformed[nextFilter++];
        const end = current.end === undefined ? undefined : transformed[nextFilter++];
        pathResults.push({ ...current, parent, start, end });
        break;
      }
      case 'path':
        throw new Error('Unexpected jq static path rebuild task');
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled jq path rebuild: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    default: {
      const _ex: never = task;
      throw new Error(`Unhandled jq filter transform task: ${JSON.stringify(_ex)}`);
    }
    }
  }

  if (filterResults.length !== 1 || pathResults.length !== 0) {
    throw new Error(`jq filter transform produced ${filterResults.length} filters and ${pathResults.length} paths`);
  }
  return filterResults[0]!;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
