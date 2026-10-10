import { fileURLToPath } from 'node:url';
import type ts from 'typescript';
import { operationEffect, type Effect } from '../contracts/effects.ts';
import type { SourceLocation } from '../diagnostics.ts';
import type { ContractOwner, Value } from '../analysis/values.ts';
import type { NativeModelContext } from './invoke.ts';

export type OperationAccess = 'call' | 'construct' | 'read' | 'write';

/** A selected model is evidence of a policy decision, not proof that its guards passed. */
export type OperationDecision = SourceLocation & {
  owner: number | undefined,
  operation: string,
  access: OperationAccess,
  rule: string,
  definitionFile: string,
  disposition: 'tracked' | 'intentional-none' | 'conditional',
  reason: string,
  effects: readonly Effect[],
};

/**
 * The analyzer has already resolved native identity and evaluated arguments once.
 * Rules cannot add effects or recursively execute arguments through this view.
 * Their result/argument guards live next to the effect policy, not in a config file.
 */
export type OperationInput = {
  context: Pick<NativeModelContext, 'native' | 'issue'>,
  callable: Extract<Value, { kind: 'native' }>,
  args: readonly Value[],
  node: ts.Node,
};

export type OperationRule = {
  id: string,
  /** import.meta.url of the defining module; renames do not leave stale audit paths. */
  definedIn: string,
  access: OperationAccess,
  targets: readonly string[],
  policy:
    | { kind: 'tracked', effects: readonly string[], reason: string }
    | { kind: 'intentional-none', reason: string }
    | {
      kind: 'conditional', possibleEffects: readonly string[], reason: string,
      select: (input: OperationInput) => readonly string[],
    },
  evaluate: (input: OperationInput) => Value,
};

/** Exact lookups only: a familiar receiver is not a model for every future member. */
export function indexOperations({ rules }: { rules: readonly OperationRule[] }): ReadonlyMap<string, OperationRule> {
  const index = new Map<string, OperationRule>();
  const ids = new Set<string>();
  for (const rule of rules) {
    if (rule.id.trim().length === 0 || ids.has(rule.id)) throw new Error(`Duplicate or empty operation rule: ${rule.id}`);
    ids.add(rule.id);
    if (rule.targets.length === 0 || rule.policy.reason.trim().length === 0) throw new Error(`Operation rule needs targets and a rationale: ${rule.id}`);
    fileURLToPath(rule.definedIn);
    switch (rule.policy.kind) {
    case 'tracked':
      if (rule.policy.effects.length === 0) throw new Error(`Use intentional-none with a reason, not an empty tracked rule: ${rule.id}`);
      break;
    case 'conditional':
      if (rule.policy.possibleEffects.length === 0) throw new Error(`Conditional rule needs an effect envelope: ${rule.id}`);
      break;
    case 'intentional-none': break;
    default: { const exhaustive: never = rule.policy; throw new Error(String(exhaustive)); }
    }
    for (const target of rule.targets) {
      const key = `${rule.access}:${target}`;
      if (target.length === 0 || index.has(key)) throw new Error(`Duplicate or empty operation target: ${key}`);
      index.set(key, rule);
    }
  }
  return index;
}

/** Shared dispatch cannot silently turn an unrecognized operation into none. */
export function applyOperation({ context, callable, args, owner, node, rule }: {
  context: NativeModelContext,
  callable: Extract<Value, { kind: 'native' }>,
  args: readonly Value[],
  owner: ContractOwner | undefined,
  node: ts.Node,
  rule: OperationRule,
}): Value {
  const input: OperationInput = { context: { native: context.native, issue: context.issue }, callable, args, node };
  const names = (() => {
    switch (rule.policy.kind) {
    case 'intentional-none': return [];
    case 'tracked': return rule.policy.effects;
    case 'conditional': {
      const { select, possibleEffects } = rule.policy;
      const selected = select(input);
      if (selected.some(name => !possibleEffects.includes(name))) throw new Error(`Operation escaped its declared effect envelope: ${rule.id}`);
      return selected;
    }
    default: { const exhaustive: never = rule.policy; throw new Error(String(exhaustive)); }
    }
  })();
  for (const name of names) {
    if (!context.config.definitions.some(definition => definition.name === name && definition.arguments === 'resource')) {
      throw new Error(`Selected operation uses an unregistered resource effect: ${rule.id}: ${name}`);
    }
  }
  const effects = names.map(name => operationEffect({ name }));
  // Emit even when the local policy is none. Separate diagnostics still report
  // unsupported conversions; none is never a guard or argument-evaluation bypass.
  context.recordOperation({
    owner,
    node,
    operation: callable.name,
    access: rule.access,
    rule: rule.id,
    definitionFile: fileURLToPath(rule.definedIn),
    disposition: rule.policy.kind,
    reason: rule.policy.reason,
    effects,
  });
  context.addEffects({ owner, effects, node, reason: `Modeled operation: ${callable.name} [${rule.id}]: ${rule.policy.reason}` });
  return rule.evaluate(input);
}
