import { describe, expect, it } from "vitest";
import { ConfigError } from "./errors.js";
import { renderDeep, renderTemplate } from "./template.js";

describe("renderTemplate", () => {
  it("replaces {{VAR}} placeholders", () => {
    expect(renderTemplate("open {{APP_URL}}/login", { APP_URL: "http://x" })).toBe(
      "open http://x/login",
    );
  });

  it("tolerates whitespace inside braces", () => {
    expect(renderTemplate("{{ X }}", { X: "1" })).toBe("1");
  });

  it("throws on unknown variables (fail loud, not empty URLs)", () => {
    expect(() => renderTemplate("{{NOPE}}", {})).toThrowError(
      /unknown variable \{\{NOPE\}\}/,
    );
  });

  it("returns strings without variables unchanged", () => {
    expect(renderTemplate("no vars here", {})).toBe("no vars here");
  });
});

describe("renderDeep", () => {
  it("renders variables in nested structures", () => {
    const input = {
      url: "{{APP_URL}}/home",
      list: ["{{A}}", { deep: { v: "{{B}}" } }],
      n: 42,
    };
    const out = renderDeep(input, { APP_URL: "http://app", A: "1", B: "2" });
    expect(out).toEqual({
      url: "http://app/home",
      list: ["1", { deep: { v: "2" } }],
      n: 42,
    });
  });

  it("throws with the variable name on unknown vars anywhere", () => {
    expect(() =>
      renderDeep({ a: { b: "{{MISSING}}" } }, {}),
    ).toThrowError(ConfigError);
  });
});
