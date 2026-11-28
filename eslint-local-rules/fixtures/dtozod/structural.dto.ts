import * as dtozod from '@/utils/dtozod';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/dtozod/missingAsUndefined';
import { optionalExperimentalFieldDtoSchema } from '@/00-storage/00-dto/compatibility/experimental-field';

export type { nameSchema } from './domain';
export { type createSchema } from './domain';
export type * from './domain';
export type { z } from 'zod';
export { name } from './domain';
export const NameDtoSchema = dtozod.string();
export const ObjectDtoSchema = resolveMissingAsUndefined(dtozod.object({
  name: missingAsUndefined(dtozod.string()),
}));
export const experimental = optionalExperimentalFieldDtoSchema({ schema: ObjectDtoSchema });
export const shapes = { name: NameDtoSchema };
export const createDto = () => dtozod.object(shapes);
export type Dto = dtozod.infer<typeof ObjectDtoSchema>;
// Metadata-shaped data is not a native schema's executable definition.
export const ordinaryData = { _zod: { input: 1, output: 2, def: {}, run: 'plain data' } };
