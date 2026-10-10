import { z } from 'zod';

// Domain schemas may enforce constraints; exporting one as a DTO may not.
export const nameSchema = z.string().min(1);
export function createSchema() { return z.object({ name: nameSchema }).strict(); }
export const name = 'display name';
