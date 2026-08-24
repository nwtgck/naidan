import { describe, expect, it } from "vitest";
import { compareGitPaths, sortGitPaths } from "./path-order";

describe("Git pathname ordering", () => {
  it("orders pathnames by UTF-8 bytes instead of UTF-16 surrogate order", () => {
    const bmpPrivateUse = "\uE000.txt";
    const supplementary = "\u{10000}.txt";
    expect([bmpPrivateUse, supplementary].sort()).toEqual([supplementary, bmpPrivateUse]);
    expect(sortGitPaths({ paths: [supplementary, bmpPrivateUse] })).toEqual([bmpPrivateUse, supplementary]);
    expect(compareGitPaths({ left: bmpPrivateUse, right: supplementary })).toBeLessThan(0);
  });
});
