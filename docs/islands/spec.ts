export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type DocsIslandStart = 'dom-content-loaded' | 'interactive';

export type DocsIslandSpec<Payload extends JsonObject> = Readonly<{
  id: string;
  parse: ({ serialized }: { serialized: string }) => Payload;
  start: DocsIslandStart;
}>;

export function defineDocsIslandSpec<Payload extends JsonObject>({ id, parse, start }: {
  id: string;
  parse: ({ serialized }: { serialized: string }) => Payload;
  start: DocsIslandStart;
}): DocsIslandSpec<Payload> {
  return { id, parse, start };
}
