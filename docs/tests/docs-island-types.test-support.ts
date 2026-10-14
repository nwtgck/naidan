import type { DocsIslandFactory } from '../islands/core';

type Payload = { copy: string; chrome: string };

// Compiled by the public Docs type gate. This function is never called.
export function verifyDocsIslandAuthorTypes({ factory, union }: {
  factory: DocsIslandFactory<Payload>;
  union: Payload | (Payload & { debugOnly: boolean });
}): void {
  factory({ copy: 'copy', chrome: 'chrome' });
  // @ts-expect-error A required component prop cannot be omitted.
  factory({ copy: 'copy' });
  // @ts-expect-error A component prop cannot have the wrong value type.
  factory({ copy: 1, chrome: 'chrome' });
  // @ts-expect-error An extra key in one union branch cannot be hidden.
  factory(union);
  // @ts-expect-error The factory must not expose its raw component.
  void factory.component;
}
