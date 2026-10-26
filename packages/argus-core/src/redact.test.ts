import { describe, expect, it } from "vitest";
import { Redactor } from "./redact.js";

describe("Redactor", () => {
  it("redacts JWTs", () => {
    const token =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w";
    const out = new Redactor().run(`Bearer ${token} attached`);
    expect(out).not.toContain(token);
    expect(out).toContain("[REDACTED:JWT]");
  });

  it("redacts provider API keys", () => {
    const out = new Redactor().run("key: sk-abcdefghij1234567890abcdef");
    expect(out).not.toContain("sk-abcdefghij1234567890abcdef");
    expect(out).toContain("[REDACTED:API_KEY]");
  });

  it("redacts credentials in query strings and log lines", () => {
    const out = new Redactor().run("password=SuperSecret123 got 200");
    expect(out).not.toContain("SuperSecret123");
    expect(out).toContain("[REDACTED:CREDENTIAL]");
  });

  it("scrubs the values of named env secrets", () => {
    process.env.ARGUS_TEST_SMTP_PASS = "hunter2-secret-value";
    try {
      const r = new Redactor({ envSecrets: ["ARGUS_TEST_SMTP_PASS"] });
      const out = r.run("auth failed for user x hunter2-secret-value");
      expect(out).not.toContain("hunter2-secret-value");
      expect(out).toContain("[REDACTED]");
    } finally {
      delete process.env.ARGUS_TEST_SMTP_PASS;
    }
  });

  it("applies user custom patterns", () => {
    const r = new Redactor({ extraPatterns: ["CORP-\\d{4}"] });
    expect(r.run("ticket CORP-1234")).toContain("[REDACTED:CUSTOM]");
  });

  it("leaves ordinary text untouched", () => {
    const r = new Redactor();
    expect(r.run("step 3 failed: expected redirect to /dashboard")).toBe(
      "step 3 failed: expected redirect to /dashboard",
    );
  });
});
