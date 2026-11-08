import { describe, expect, expectTypeOf, it } from 'vitest';
import * as dtozod from '@/utils/dtozod';
import {
  ExperimentalWorkflowValueSchemaDto,
  type ExperimentalWorkflowValueSchemaTypeDto,
} from './experimental-workflow.dto';

const nestedValueSchema = dtozod.object({ value: ExperimentalWorkflowValueSchemaDto });

describe('Recursive workflow DTO schema contract', () => {
  it('tracks DTO optionality metadata without making a nested value optional', () => {
    expectTypeOf<ExperimentalWorkflowValueSchemaTypeDto['_zod']['optin']>().toEqualTypeOf<dtozod.DtoSchema['_zod']['optin']>();
    expectTypeOf<ExperimentalWorkflowValueSchemaTypeDto['_zod']['optout']>().toEqualTypeOf<dtozod.DtoSchema['_zod']['optout']>();
    expectTypeOf<dtozod.input<typeof nestedValueSchema>>().toEqualTypeOf<{
      value: dtozod.input<typeof ExperimentalWorkflowValueSchemaDto>,
    }>();
    expectTypeOf<dtozod.output<typeof nestedValueSchema>>().toEqualTypeOf<{
      value: dtozod.output<typeof ExperimentalWorkflowValueSchemaDto>,
    }>();
    expect(nestedValueSchema.safeParse({}).success).toBe(false);
    expect(nestedValueSchema.safeParse({ value: undefined }).success).toBe(false);
  });

  it('still checks recursive branches and their field types at compile time', () => {
    const invalidContracts = () => {
      // @ts-expect-error The recursive schema must reject a wrong field type.
      const invalid: ExperimentalWorkflowValueSchemaTypeDto = dtozod.discriminatedUnion('type', [
        dtozod.object({
          type: dtozod.literal('format_number'),
          value: ExperimentalWorkflowValueSchemaDto,
          minDigits: dtozod.string(),
        }),
      ]);
      // @ts-expect-error A nested value is required in the input contract.
      const missing: dtozod.input<typeof nestedValueSchema> = {};
      // @ts-expect-error Recursive values cannot be replaced by plain strings.
      const malformed: dtozod.output<typeof ExperimentalWorkflowValueSchemaDto> = { type: 'array', items: ['wrong'] };
      return { invalid, missing, malformed };
    };
    expect(invalidContracts).toBeTypeOf('function');
  });

  it('restores omitted legacy fields inside recursively nested messages', () => {
    const legacy = {
      type: 'conversation',
      messages: [{
        role: 'tool',
        parts: [{
          type: 'tool_result',
          id: 'call',
          status: 'success',
          content: {
            type: 'range',
            start: { type: 'literal', value: 0 },
            step: { type: 'literal', value: 1 },
          },
        }],
      }],
    };
    const parsed = ExperimentalWorkflowValueSchemaDto.parse(legacy);
    if (parsed.type !== 'conversation') {
      throw new Error('Expected conversation');
    }
    const part = parsed.messages[0]?.parts[0];
    if (part?.type !== 'tool_result' || part.content.type !== 'range') {
      throw new Error('Expected range result');
    }
    expect(Object.hasOwn(part, 'code')).toBe(true);
    expect(part.code).toBeUndefined();
    expect(Object.hasOwn(part.content, 'end')).toBe(true);
    expect(part.content.end).toBeUndefined();
    expect(ExperimentalWorkflowValueSchemaDto.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('keeps arbitrary literal data while dropping only unknown structural fields', () => {
    const value = { type: 'future-data', nested: { unknown: [1, null, 'kept'] } };
    const parsed = ExperimentalWorkflowValueSchemaDto.parse({ type: 'literal', value, futureField: true });
    expect(parsed).toEqual({ type: 'literal', value });
    expect(ExperimentalWorkflowValueSchemaDto.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it.each([
    undefined,
    {},
    { type: 'future-expression' },
    { type: 'format_number', value: { type: 'literal', value: 1 }, minDigits: '2' },
    { type: 'array', items: ['invalid'] },
  ])('rejects malformed recursive input %j', value => {
    expect(ExperimentalWorkflowValueSchemaDto.safeParse(value).success).toBe(false);
  });
});
