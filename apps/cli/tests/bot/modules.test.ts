import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBotModules } from "../../src/bot/modules.js";

describe("bot JS modules", () => {
  it("loads explicitly configured sensor and drive modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "myloop-modules-"));
    const sensorPath = join(root, "repo-health.mjs");
    const drivePath = join(root, "repo-maintenance.mjs");
    await writeFile(sensorPath, `
      export default {
        id: "test.repo.health",
        async read() {
          return { dirtyFiles: 8 };
        },
      };
    `);
    await writeFile(drivePath, `
      export default {
        name: "test-repo-maintenance",
        requires: ["test.repo.health"],
        threshold: 0.5,
        cooldownMs: 0,
        evaluate({ sensors }) {
          const dirtyFiles = sensors["test.repo.health"]?.dirtyFiles ?? 0;
          if (dirtyFiles === 0) return null;
          return {
            pressure: Math.min(1, dirtyFiles / 10),
            prompt: "Check repository state.",
          };
        },
      };
    `);

    try {
      const { sensors, drives } = await loadBotModules({
        sensorPaths: [sensorPath],
        drivePaths: [drivePath],
        cwd: root,
      });
      expect(sensors).toHaveLength(1);
      expect(drives).toHaveLength(1);

      const snapshot = { "test.repo.health": { dirtyFiles: 8 } };
      expect(await drives[0]?.evaluate({ sensors: snapshot })).toEqual({
        pressure: 0.8,
        prompt: "Check repository state.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate sensor ids and unknown drive requirements", async () => {
    const root = await mkdtemp(join(tmpdir(), "myloop-modules-invalid-"));
    const sensorPath = join(root, "repo-health.mjs");
    const duplicatePath = join(root, "repo-health-duplicate.mjs");
    const drivePath = join(root, "repo-maintenance.mjs");
    await Promise.all([
      writeFile(sensorPath, `export default { id: "test.repo.health", read: () => ({}) };`),
      writeFile(duplicatePath, `export default { id: "test.repo.health", read: () => ({}) };`),
      writeFile(drivePath, `export default {
        name: "test-repo-maintenance",
        requires: ["test.repo.missing"],
        threshold: 0.5,
        cooldownMs: 0,
        evaluate: () => null,
      };`),
    ]);

    try {
      await expect(loadBotModules({
        sensorPaths: [sensorPath],
        cwd: root,
      })).resolves.toHaveProperty("sensors.length", 1);
      await expect(loadBotModules({
        sensorPaths: [sensorPath, duplicatePath],
        cwd: root,
      })).rejects.toThrow('duplicate sensor id "test.repo.health"');
      await expect(loadBotModules({
        sensorPaths: [sensorPath],
        drivePaths: [drivePath],
        cwd: root,
      })).rejects.toThrow('requires unknown sensor "test.repo.missing"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
