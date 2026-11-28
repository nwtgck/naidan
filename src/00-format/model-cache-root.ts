const path = ['models'] as const;

/** The shared OPFS root of the inference engines' model caches. */
export const modelCacheOpfsRoot = { name: path[0], path };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
