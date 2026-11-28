import { nameSchema, createSchema } from './domain';

export const NameDtoSchema = nameSchema;
export const ObjectDtoSchema = createSchema();
export { nameSchema as AliasedDtoSchema };
export { nameSchema as ReexportedDtoSchema } from './domain';
export const createDtoSchema = () => createSchema();
export const shapes = { name: nameSchema };
export const schemas = [nameSchema];
export const byKey: Record<string, typeof nameSchema> = { name: nameSchema };
export default nameSchema;
