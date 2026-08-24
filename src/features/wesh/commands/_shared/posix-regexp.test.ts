import { describe, expect, it } from "vitest";
import {
  compileBasicRegularExpression,
  compileExtendedRegularExpression,
  translateExtendedRegularExpression,
} from "./posix-regexp";

function compileTestRegularExpression({
  syntax,
  source,
  characterClassMode,
  dotMode,
  excludeSurrogateEscapes,
}: {
  syntax: "basic" | "extended",
  source: string,
  characterClassMode: "ascii" | "unicode",
  dotMode: "javascript" | "non-newline" | "non-null",
  excludeSurrogateEscapes: boolean,
}): RegExp {
  switch (syntax) {
  case "basic":
    return compileBasicRegularExpression({
      source,
      flags: "",
      characterClassMode,
      gnuWordOperators: true,
      basicOperatorMode: "gnu",
      dotMode,
      excludeSurrogateEscapes,
    });
  case "extended":
    return compileExtendedRegularExpression({
      source,
      flags: "",
      characterClassMode,
      gnuWordOperators: true,
      dotMode,
      excludeSurrogateEscapes,
    });
  default: {
    const _ex: never = syntax;
    throw new Error(`Unhandled test regular-expression syntax: ${_ex}`);
  }
  }
}

describe("POSIX regular expression translation", () => {
  it.each(["basic", "extended"] as const)("makes %s dot match every non-newline character", (syntax) => {
    const regex = compileTestRegularExpression({
      syntax,
      source: ".",
      characterClassMode: "ascii",
      dotMode: "non-newline",
      excludeSurrogateEscapes: false,
    });

    for (const character of ["a", "\0", "\r", "\u2028", "\u2029"]) {
      expect(regex.test(character)).toBe(true);
    }
    expect(regex.test("\n")).toBe(false);
  });

  it.each(["basic", "extended"] as const)("keeps escaped %s dots literal", (syntax) => {
    const regex = compileTestRegularExpression({
      syntax,
      source: String.raw`\.`,
      characterClassMode: "ascii",
      dotMode: "non-newline",
      excludeSurrogateEscapes: false,
    });

    expect(regex.test(".")).toBe(true);
    expect(regex.test("\r")).toBe(false);
  });

  it.each(["basic", "extended"] as const)("makes %s dot exclude NUL in NUL-record mode", (syntax) => {
    const regex = compileTestRegularExpression({
      syntax,
      source: ".",
      characterClassMode: "ascii",
      dotMode: "non-null",
      excludeSurrogateEscapes: false,
    });

    for (const character of ["a", "\n", "\r", "\u2028", "\u2029"]) {
      expect(regex.test(character)).toBe(true);
    }
    expect(regex.test("\0")).toBe(false);
  });

  it.each(["basic", "extended"] as const)("can exclude command-data surrogate escapes from %s classes", (syntax) => {
    const sentinel = "\udcff";
    for (const source of [".", "[^A]", String.raw`\W`]) {
      const regex = compileTestRegularExpression({
        syntax,
        source,
        characterClassMode: "unicode",
        dotMode: "non-newline",
        excludeSurrogateEscapes: true,
      });
      expect(regex.test(sentinel)).toBe(false);
      expect(regex.test("!")).toBe(true);
    }
  });

  it("normalizes deeply nested repeated quantifiers without host stack recursion", () => {
    const depth = 20_000;
    const nested = `${"(".repeat(depth)}a${")".repeat(depth)}`;

    const translated = translateExtendedRegularExpression({
      source: `${nested}**`,
      characterClassMode: "ascii",
      gnuWordOperators: true,
      dotMode: 'javascript',
      excludeSurrogateEscapes: false,
    });

    expect(translated.source).toBe(`(?:${nested}*)*`);
  });

  it("preserves malformed group suffixes while normalizing completed groups", () => {
    for (const [source, expected] of [
      ["a**", "(?:a*)*"],
      ["(a)**", "(?:(a)*)*"],
      ["((a))**", "(?:((a))*)*"],
      ["(a)+?", "(?:(a)+)?"],
      ["(?:a)**", "(?:(?:a)*)*"],
      ["(((a", "(((a"],
      ["a)))", "a)))"],
    ] as const) {
      expect(translateExtendedRegularExpression({
        source,
        characterClassMode: "ascii",
        gnuWordOperators: true,
        dotMode: 'javascript',
        excludeSurrogateEscapes: false,
      }).source).toBe(expected);
    }
  });

});
