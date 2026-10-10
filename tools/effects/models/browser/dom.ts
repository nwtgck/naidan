import ts from 'typescript';
import { SCALAR, UNKNOWN, type Value } from '../../analysis/values.ts';
import { isScalarValue } from '../../analysis/value-guards.ts';
import type { OperationInput, OperationRule } from '../operation.ts';
import { passiveArguments, scalarArguments } from './guards.ts';
import { classifyUrlTarget } from './url-target.ts';

export const FRESH_IMAGE = 'dom:image';

function imageTarget({ input }: { input: OperationInput }): Value | undefined {
  return input.callable.name.endsWith('.setAttribute') ? input.args[1] : input.args[0];
}

function validateImage({ input }: { input: OperationInput }): Value {
  const result = classifyUrlTarget({ value: imageTarget({ input }), use: 'image' });
  if (result.unsupported !== undefined) input.context.issue({ node: input.node, code: 'unsupported', message: result.unsupported });
  const receiver = input.callable.receiver;
  if (receiver?.kind !== 'native' || receiver.name !== FRESH_IMAGE) {
    input.context.issue({ node: input.node, code: 'unsupported', message: 'Image acquisition requires a proven fresh image. Existing images may have srcset/picture candidates not described by src.' });
  }
  if (input.callable.name.endsWith('.setAttribute')) {
    const name = input.args[0];
    if (name?.kind !== 'scalar' || name.stringEvidence?.kind !== 'literal'
      || name.stringEvidence.values.length === 0 || name.stringEvidence.values.some(value => value.toLowerCase() !== 'src')) {
      input.context.issue({ node: input.node, code: 'unsupported', message: 'Only the explicit image src attribute is modeled; event, srcset and other attributes need separate policies.' });
    }
  }
  return SCALAR;
}

/** Co-located identity, policy and value guards. No generic DOM-write exemption. */
export const DOM_OPERATIONS: readonly OperationRule[] = [
  {
    id: 'image.construct',
    definedIn: import.meta.url,
    access: 'construct',
    targets: ['Image'],
    policy: { kind: 'intentional-none', reason: 'Creating an empty built-in image does not request a resource. Setting its source is a separate operation.' },
    evaluate: input => {
      scalarArguments(input); return input.context.native({ name: FRESH_IMAGE, receiver: undefined });
    },
  },
  {
    id: 'image.create-element',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['document.createElement'],
    policy: { kind: 'intentional-none', reason: 'Only a verified built-in img without custom-element options is accepted here. Other elements are not implicitly safe.' },
    evaluate: input => {
      const tag = input.args[0];
      if (input.args.length !== 1 || tag?.kind !== 'scalar' || tag.stringEvidence?.kind !== 'literal'
        || tag.stringEvidence.values.length === 0 || tag.stringEvidence.values.some(value => value.toLowerCase() !== 'img')) {
        input.context.issue({ node: input.node, code: 'unsupported', message: 'createElement currently requires the literal img tag and no custom-element options.' }); return UNKNOWN;
      }
      return input.context.native({ name: FRESH_IMAGE, receiver: undefined });
    },
  },
  ...(['write', 'call'] as const).map(access => ({
    id: `image.source.${access}`,
    definedIn: import.meta.url,
    access,
    targets: ['dom:image', 'HTMLImageElement'].map(receiver => {
      switch (access) {
      case 'write': return `${receiver}.src`;
      case 'call': return `${receiver}.setAttribute`;
      default: { const exhaustive: never = access; throw new Error(String(exhaustive)); }
      }
    }),
    policy: {
      kind: 'conditional',
      possibleEffects: ['network.http', 'hostfs.read'],
      reason: 'Image source activation can fetch even while detached. Passive blob/data decoding adds no request; original storage/network reads remain at their own origins.',
      select: input => classifyUrlTarget({ value: imageTarget({ input }), use: 'image' }).effects,
    },
    evaluate: input => validateImage({ input }),
  } satisfies OperationRule)),
  {
    id: 'image.metadata',
    definedIn: import.meta.url,
    access: 'read',
    targets: ['dom:image', 'HTMLImageElement'].flatMap(receiver => ['src', 'currentSrc', 'srcset', 'complete', 'naturalWidth', 'naturalHeight', 'width', 'height', 'alt'].map(key => `${receiver}.${key}`)),
    policy: { kind: 'intentional-none', reason: 'Reading image metadata does not initiate a request and does not prove the current URL or source-candidate state.' },
    evaluate: () => SCALAR,
  },
  {
    id: 'blob.construct',
    definedIn: import.meta.url,
    access: 'construct',
    targets: ['Blob'],
    policy: { kind: 'intentional-none', reason: 'Constructing an immutable memory Blob is not persistent storage. Iterator/coercion inputs must still be checked.' },
    evaluate: input => {
      passiveArguments(input);
      const parts = ts.isNewExpression(input.node) ? input.node.arguments?.[0] : undefined;
      if (parts !== undefined && !ts.isArrayLiteralExpression(parts)) {
        input.context.issue({ node: input.node, code: 'unsupported', message: 'Blob part iteration needs a fresh array literal; a typed array may have a custom iterator.' });
      }
      return input.context.native({ name: 'Blob', receiver: undefined });
    },
  },
  {
    id: 'blob.create-object-url',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['URL.createObjectURL'],
    policy: { kind: 'intentional-none', reason: 'Creating a Blob URL maps already acquired bytes in the browser; it does not perform the earlier file read or fetch again.' },
    evaluate: input => {
      if (input.args.length !== 1 || input.args[0]?.kind !== 'native' || !['Blob', 'File'].includes(input.args[0].name)) {
        input.context.issue({ node: input.node, code: 'unsupported', message: 'Object URL creation needs a checked Blob/File, not an asserted or unknown input.' }); return SCALAR;
      }
      return { kind: 'scalar', keys: undefined, truthiness: 'truthy', stringEvidence: { kind: 'object-url' } };
    },
  },
  {
    id: 'blob.revoke-object-url',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['URL.revokeObjectURL'],
    policy: { kind: 'intentional-none', reason: 'Revoking a browser Blob mapping does not write application content to persistent storage.' },
    evaluate: input => {
      scalarArguments(input); return SCALAR;
    },
  },
  {
    id: 'document.location',
    definedIn: import.meta.url,
    access: 'read',
    targets: ['document.location'],
    policy: { kind: 'intentional-none', reason: 'Obtaining the location object does not navigate.' },
    evaluate: input => input.context.native({ name: 'location', receiver: undefined }),
  },
  ...(['call', 'write'] as const).map(access => ({
    id: `navigation.target.${access}`,
    definedIn: import.meta.url,
    access,
    targets: (() => {
      switch (access) {
      case 'call': return ['open', 'location.assign', 'location.replace', 'Location.assign', 'Location.replace'];
      case 'write': return ['location.href', 'Location.href'];
      default: { const exhaustive: never = access; throw new Error(String(exhaustive)); }
      }
    })(),
    policy: {
      kind: 'conditional',
      possibleEffects: ['network.http', 'hostfs.read'],
      reason: 'Explicit navigation requests an external document. Same-origin HTTP is still network; blob/data/script execution is not classified as passive image loading.',
      select: input => classifyUrlTarget({ value: input.args[0], use: 'navigation' }).effects,
    },
    evaluate: input => {
      if (input.args.some(value => !isScalarValue(value))) scalarArguments(input);
      const result = classifyUrlTarget({ value: input.args[0], use: 'navigation' });
      if (result.unsupported !== undefined) input.context.issue({ node: input.node, code: 'unsupported', message: result.unsupported });
      // A returned browsing context has no general script/postMessage model yet.
      return input.callable.name === 'open' ? UNKNOWN : SCALAR;
    },
  } satisfies OperationRule)),
];
