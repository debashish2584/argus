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

  it("exposes studio as a subcommand tree (serve + add/remove/list/open)", () => {
    const studio = buildProgram().commands.find((c) => c.name() === "studio");
    expect(studio).toBeDefined();
    const subs = (studio!.commands ?? []).map((c) => c.name());
    expect(subs).toEqual(expect.arrayContaining(["add", "remove", "list", "open"]));
    // serve options live on the studio command itself
    expect(studio!.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(["--port", "--host", "--open", "--project"]),
    );
    // `open` declares no options of its own — port/host targeting comes from
    // the parent `studio` command (see the routing test below).
    const open = studio!.commands.find((c) => c.name() === "open");
    expect(open).toBeDefined();
    expect(open!.options.length).toBe(0);
  });

  it("routes --port/--host after `studio open` to the parent studio command", async () => {
    // Commander's default non-positional option parsing hands options to the
    // nearest ancestor that declares them, wherever they appear on the line.
    // `open` must read its targeting from the parent — lock that routing in,
    // because a silent fallback to the default port is otherwise invisible.
    const studio = buildProgram().commands.find((c) => c.name() === "studio")!;
    const open = studio.commands.find((c) => c.name() === "open")!;
    // The real action would start a server and open a browser — no-op it.
    (open as unknown as { _actionHandler: unknown })._actionHandler = async () => {};
    await buildProgram().parseAsync(["node", "argus", "studio", "open", "--port", "4911"]);
    expect(studio.opts().port).toBe("4911");
  });
});
