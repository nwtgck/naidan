declare const containerCoordinationKeyBrand: unique symbol;

/**
 * Opaque runtime identity issued by the container coordinator.
 *
 * Equal root keys, File System IDs, or copied bytes do not establish physical
 * container identity. Cross-view operations must receive the same coordinator-
 * owned object to prove that both sides address one physical container.
 */
export type ContainerCoordinationKey = object & {
  readonly [containerCoordinationKeyBrand]: true;
};

export function isSameContainerCoordinationKey({ left, right }: {
  left: ContainerCoordinationKey;
  right: ContainerCoordinationKey;
}): boolean {
  return left === right;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
