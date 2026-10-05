/** Keep a wider logical prompt batch while retaining a conservative native
 * microbatch. llama.cpp may split the logical batch internally, which reduces
 * JS/native crossings without forcing a matching compute microbatch. */
export const prefillBatchTokens = 512;
export const prefillMicroBatchTokens = 128;

export const TEST_ONLY = {
};
