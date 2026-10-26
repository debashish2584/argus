import { describe, expect, it } from "vitest";
import { buildProgram } from "./bin.js";

/**
 * Regression: the commander tree must build without duplicate-command
 * collisions (a multi-word registration like `studio add <dir>` on the root
 * parses as a second `studio` command and throws at load time — the CLI
 * would be unusable, and only a runtime smoke test would have caught it).
 */
describe("argus CLI command tree", () => {
  it("builds the full tree (no duplicate command registrations)", () => {
    const program = buildProgram(); // throws if any name collides
    const names = program.commands.map((c) => c.name());
    for (const expected of ["init", "doctor", "version", "plan", "run", "heal", "triage", "report", "inspect"]) {
      expect(names).toContain(expected);
    }
  });

  it("exposes studio as a subcommand tree (serve + add/remove/list)", () => {
    const studio = buildProgram().commands.find((c) => c.name() === "studio");
    expect(studio).toBeDefined();
    const subs = (studio!.commands ?? []).map((c) => c.name());
    expect(subs).toEqual(expect.arrayContaining(["add", "remove", "list"]));
    // serve options live on the studio command itself
    expect(studio!.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(["--port", "--host", "--open", "--project"]),
    );
  });
});
