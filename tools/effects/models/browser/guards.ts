import { isScalarValue, passiveData } from '../../analysis/value-guards.ts';
import type { OperationInput } from '../operation.ts';

export function scalarArguments({ context, callable, args, node }: OperationInput): void {
  if (args.some(value => !isScalarValue(value))) {
    context.issue({ node, code: 'unsupported', message: `Unverified argument conversion in ${callable.name}; object keys and coercion hooks need a separate model.` });
  }
}

export function passiveArguments({ context, callable, args, node }: OperationInput): void {
  if (args.some(value => !passiveData({ value, seen: new Set() }))) {
    context.issue({ node, code: 'unsupported', message: `Argument conversion for ${callable.name} requires checked passive data or a dedicated callback model.` });
  }
}
