function advertisedSubgroupSize({ size }: { size: number }): boolean {
  return Number.isInteger(size) && size >= 4 && size <= 128 && (size & (size - 1)) === 0;
}

/** Revision 2 explicitly requests size 16; advertised limits remain unchanged. */
export function isQ8Revision2AutoReport({ codegenRevision, variant, algorithm, workgroupSize, logicalSubgroupSize, realMinSubgroupSize, realMaxSubgroupSize, rowsPerTile, outputsPerWorkgroup, cooperativeSubgroupReduction }: {
  codegenRevision: number, variant: string, algorithm: string, workgroupSize: number, logicalSubgroupSize: number,
  realMinSubgroupSize: number, realMaxSubgroupSize: number, rowsPerTile: number, outputsPerWorkgroup: number, cooperativeSubgroupReduction: boolean,
}): boolean {
  return codegenRevision === 2 && variant === 'auto' && algorithm === 'independent'
    && workgroupSize === 128 && logicalSubgroupSize === 16 && rowsPerTile === 4 && outputsPerWorkgroup === 32 && !cooperativeSubgroupReduction
    && advertisedSubgroupSize({ size: realMinSubgroupSize }) && advertisedSubgroupSize({ size: realMaxSubgroupSize })
    && realMinSubgroupSize <= 16 && realMaxSubgroupSize >= 16;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
