import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const designMd = readFileSync(new URL("../../DESIGN.md", import.meta.url), "utf8");
const globalsCss = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

// The colour tokens of one theme in DESIGN.md's front matter, as CSS custom properties: each
// `name: "#hex"` line, and the avatar tints as --av0 to --av4.
function designTokens(theme: "light" | "dark"): Record<string, string> {
  const block = designMd.match(new RegExp(`\\n  ${theme}:\\n((?:    .*\\n)+)`))?.[1];
  if (!block) throw new Error(`DESIGN.md has no ${theme} colours`);

  const tokens: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/^ {4}([a-z-]+): "(#[0-9a-f]{6})"/gm)) {
    tokens[`--${name}`] = String(value);
  }
  const avatars = block.match(/avatar: \[(.*)\]/)?.[1]?.match(/#[0-9a-f]{6}/g) ?? [];
  avatars.forEach((value, index) => (tokens[`--av${index}`] = value));
  return tokens;
}

// The custom properties a CSS block declares.
function declared(css: string): Record<string, string> {
  return Object.fromEntries([...css.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [String(name), String(value).trim()]));
}

const lightCss = globalsCss.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
const darkCss = globalsCss.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)?.[1] ?? "";

describe("globals.css", () => {
  it.each(["light", "dark"] as const)("declares every %s colour token from DESIGN.md", (theme) => {
    const expected = designTokens(theme);
    expect(Object.keys(expected).length).toBeGreaterThan(20);

    const actual = declared(theme === "light" ? lightCss : darkCss);
    for (const [name, value] of Object.entries(expected)) {
      expect(actual[name], name).toBe(value);
    }
  });

  it("follows the system's colour scheme", () => {
    expect(lightCss).toMatch(/color-scheme:\s*light dark/);
    expect(darkCss.length).toBeGreaterThan(0);
  });
});
