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

    expect(result).toBe("Base instructions\n\n# Skill: Testing\n\nRun tests.");
  });

  it("joins multiple skills in order with their catalog metadata", () => {
    const result = composeSystem({
      base: "Base",
      skills: [
        { name: "A", description: "first", instructions: "Do A." },
        { name: "B", description: "second", instructions: "Do B." },
      ],
    });

    expect(result).toBe("Base\n\n# Skill: A\n\nDo A.\n\n# Skill: B\n\nDo B.");
  });

  it("falls back to the skill list when base is empty", () => {
    const result = composeSystem({
      base: "   ",
      skills: [{ name: "Only", description: "ignored", instructions: "Run." }],
    });

    expect(result).toBe("# Skill: Only\n\nRun.");
  });

  it("returns an empty string when nothing is provided", () => {
    expect(composeSystem({ base: "" })).toBe("");
    expect(composeSystem({ base: "", skills: [] })).toBe("");
  });
});
