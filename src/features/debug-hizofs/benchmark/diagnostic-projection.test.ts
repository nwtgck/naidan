import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  HIZOFS_V1_PERSISTED_RECORD_KIND_DIAGNOSTIC_NAMES,
} from '@/00-storage/service/hizofs/00-format';
import { describe, expect, it } from 'vitest';

describe('HizoFS V1 benchmark diagnostic projection', () => {
  it('projects every authoritative record-kind name without numeric authority', () => {
    expect(HIZOFS_V1_PERSISTED_RECORD_KIND_DIAGNOSTIC_NAMES).toEqual(
      Object.keys(HIZOFS_V1_FORMAT_CONSTANTS.recordKinds),
    );
    expect(HIZOFS_V1_PERSISTED_RECORD_KIND_DIAGNOSTIC_NAMES.every(
      value => typeof value === 'string',
    )).toBe(true);
  });
});
