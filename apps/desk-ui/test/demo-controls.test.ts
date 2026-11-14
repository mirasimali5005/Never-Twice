// Demo controls: which buttons each real demo stage enables.
import { describe, expect, it } from "vitest";
import { enabledFor } from "../src/components/DemoControls";

describe("demo controls", () => {
  it("enables one step at a time from the computed stage", () => {
    expect(enabledFor("Paused")).toEqual({ go: true, resume: false, audit: false, "late-commit": false });
    expect(enabledFor("Payments sending")).toEqual({ go: false, resume: true, audit: false, "late-commit": false });
    expect(enabledFor("Crash")).toEqual({ go: false, resume: true, audit: false, "late-commit": false });
    expect(enabledFor("Recovered")).toEqual({ go: false, resume: false, audit: true, "late-commit": true });
    expect(enabledFor("Audited")).toEqual({ go: false, resume: false, audit: false, "late-commit": true });
    expect(enabledFor(null)).toEqual({ go: false, resume: false, audit: false, "late-commit": false });
  });
});
