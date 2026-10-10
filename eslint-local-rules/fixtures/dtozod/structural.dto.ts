import * as dtozod from '@/utils/dtozod';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/dtozod/missingAsUndefined';
import { optionalExperimentalFieldSchemaDto } from '@/00-storage/00-dto/compatibility/experimental-field';

export type { nameSchema } from './domain';
export { type createSchema } from './domain';
export type * from './domain';
export type { z } from 'zod';
export { name } from './domain';
export const NameSchemaDto = dtozod.string();
export const ObjectSchemaDto = resolveMissingAsUndefined(dtozod.object({
  name: missingAsUndefined(dtozod.string()),
}));
export const experimental = optionalExperimentalFieldSchemaDto({ schema: ObjectSchemaDto });
export const shapes = { name: NameSchemaDto };
export const createDto = () => dtozod.object(shapes);
export type Dto = dtozod.infer<typeof ObjectSchemaDto>;
// Metadata-shaped data is not a native schema's executable definition.
export const ordinaryData = { _zod: { input: 1, output: 2, def: {}, run: 'plain data' } };
