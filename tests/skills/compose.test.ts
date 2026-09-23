import { describe, expect, it } from "vitest";
import { composeSystem } from "../../src/skills/compose.js";

describe("composeSystem", () => {
  it("joins non-empty skill sections", () => {
    const result = composeSystem({
      base: "Base instructions",
      skills: [
        { name: "Testing", description: "ignored", instructions: "Run tests." },
      ],
    });

    expect(result).toBe("Base instructions\n\n## Skill: Testing\n\nRun tests.");
  });
});
