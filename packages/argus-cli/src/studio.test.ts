/**
 * Launcher tests for `argus studio open` (the taskbar/desktop entry point).
 *
 * Covers the pieces that make "click the icon after an update" self-heal:
 * the launch decision (open / restart / start), the health probe, and
 * stopServer (pid-file kill + the /proc listener fallback). A full
 * end-to-end restart is exercised in the dogfood report rather than here,
 * to keep the suite hermetic (no fixed ports, no real registry).
 */
import { describe, expect, it, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decideLaunch, getHealth, stopServer, findPortListener } from "./studio.js";

/* ------------------------------------------------------------------ */
/* decideLaunch — pure decision logic                                  */
/* ------------------------------------------------------------------ */

describe("decideLaunch", () => {
  it("starts the server when nothing healthy answers the port", () => {
    expect(decideLaunch(null, "abc123def456")).toBe("start");
    expect(decideLaunch({ ok: false }, "abc123def456")).toBe("start");
  });

  it("just opens the browser when the running server matches the installed build", () => {
    expect(decideLaunch({ ok: true, build_id: "abc123def456" }, "abc123def456")).toBe("open");
  });

  it("restarts when the running server is a different (stale) build", () => {
    expect(decideLaunch({ ok: true, build_id: "oldbuild000000" }, "abc123def456")).toBe("restart");
  });

  it("restarts when the running server predates the fingerprint (no build_id)", () => {
    // this is the exact reported incident: the SPA served fresh new buttons
    // while the in-memory server had no /pipeline routes at all
    expect(decideLaunch({ ok: true, version: "0.1.0", projects: 1 }, "abc123def456")).toBe("restart");
  });

  it("leaves the running server alone when the local build id is unknown", () => {
    expect(decideLaunch({ ok: true, build_id: "abc123def456" }, null)).toBe("open");
  });
});

/* ------------------------------------------------------------------ */
/* getHealth — live probe against real servers                         */
/* ------------------------------------------------------------------ */

describe("getHealth", () => {
  it("returns null for a closed port", async () => {
    expect(await getHealth("http://127.0.0.1:1/api/health")).toBeNull();
  });

  it("reads ok + build_id from a live studio server", async () => {
    const { StudioServer, buildId } = await import("@argus/studio");
    const home = mkdtempSync(path.join(tmpdir(), "argus-cli-health-"));
    try {
      const server = new StudioServer({ registryFile: path.join(home, "projects.json"), port: 0 });
      await server.start();
      const h = await getHealth(`http://127.0.0.1:${server.port}/api/health`);
      expect(h?.ok).toBe(true);
      expect(h?.build_id).toBe(buildId()); // the running server matches the installed build
      await server.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* stopServer + findPortListener — real processes, ephemeral ports     */
/* ------------------------------------------------------------------ */

interface Dummy {
  child: ChildProcess;
  pid: number;
  port: number;
  exited: Promise<number | null>;
}

/** A minimal node HTTP server on an ephemeral port answering /api/health. */
async function startDummy(): Promise<Dummy> {
  const script = [
    'const http = require("node:http");',
    'const s = http.createServer((q, r) => {',
    '  r.setHeader("content-type", "application/json");',
    '  r.end(JSON.stringify({ ok: true, build_id: "dummy" }));',
    "});",
    's.listen(0, "127.0.0.1", () => console.log(String(s.address().port)));',
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("dummy listener did not report a port")), 5000);
    let buf = "";
    child.stdout!.on("data", (c) => {
      buf += String(c);
      const m = buf.match(/(\d+)/);
      if (m && m[1]) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
    child.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  if (!child.pid) throw new Error("dummy has no pid");
  return { child, pid: child.pid, port, exited };
}

async function killDummy(d: Dummy): Promise<void> {
  d.child.kill("SIGKILL");
  await d.exited;
}

describe("stopServer", () => {
  let home: string;

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("stops the pid recorded in studio.pid", async () => {
    home = mkdtempSync(path.join(tmpdir(), "argus-cli-stop-"));
    const dummy = await startDummy();
    let stopped = false;
    try {
      writeFileSync(path.join(home, "studio.pid"), String(dummy.pid));
      await stopServer(dummy.port, home);
      stopped = true;
      await dummy.exited; // SIGTERM actually reached it
      expect(await getHealth(`http://127.0.0.1:${dummy.port}/api/health`)).toBeNull();
    } finally {
      if (!stopped) await killDummy(dummy);
    }
  });

  it("falls back to the /proc listener scan when the pid file is stale", async () => {
    if (process.platform !== "linux") return; // the fallback is a Linux-only best effort
    home = mkdtempSync(path.join(tmpdir(), "argus-cli-stop-"));
    const dummy = await startDummy();
    let stopped = false;
    try {
      writeFileSync(path.join(home, "studio.pid"), "999999"); // dead pid
      await stopServer(dummy.port, home);
      stopped = true;
      await dummy.exited;
      expect(await getHealth(`http://127.0.0.1:${dummy.port}/api/health`)).toBeNull();
    } finally {
      if (!stopped) await killDummy(dummy);
    }
  });
});

describe("findPortListener", () => {
  it("finds the pid of the process listening on a port", async () => {
    if (process.platform !== "linux") return;
    const dummy = await startDummy();
    try {
      expect(findPortListener(dummy.port)).toBe(dummy.pid);
    } finally {
      await killDummy(dummy);
    }
  });

  it("returns null when nothing listens on the port", () => {
    expect(findPortListener(1)).toBeNull();
  });
});
