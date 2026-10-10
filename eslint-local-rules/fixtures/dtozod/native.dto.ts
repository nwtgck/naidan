import { nameSchema, createSchema } from './domain';

export const NameSchemaDto = nameSchema;
export const ObjectSchemaDto = createSchema();
export { nameSchema as AliasedSchemaDto };
export { nameSchema as ReexportedSchemaDto } from './domain';
export const createSchemaDto = () => createSchema();
export const shapes = { name: nameSchema };
export const schemas = [nameSchema];
export const byKey: Record<string, typeof nameSchema> = { name: nameSchema };
export default nameSchema;
