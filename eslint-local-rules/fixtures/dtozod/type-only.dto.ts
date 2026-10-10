import type { z } from 'zod';

// A type declaration does not construct or re-export a runtime validator.
export default interface TypeOnlyContract { schema: z.ZodType }
