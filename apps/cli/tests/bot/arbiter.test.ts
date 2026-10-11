import { describe, expect, it } from "vitest";
import { DriveArbiter, type DriveArbiterDeps } from "../../src/bot/arbiter.js";
import { defineDrive, type Drive } from "../../src/bot/drives.js";

type TestWorld = {
  now: number;
  heat: number;
};

function fakeDrive(name: string, options?: {
  pressure?: number;
  prompt?: string;
  threshold?: number;
  cooldownMs?: number;
}): Drive<TestWorld> {
  return {
    name,
    threshold: options?.threshold ?? 0.5,
    cooldownMs: options?.cooldownMs ?? 0,
    evaluate: () =>
      (options?.pressure ?? 0) > 0
        ? { pressure: options?.pressure ?? 0, prompt: options?.prompt ?? `${name} act` }
        : null,
  };
}

function createDeps(world: TestWorld, overrides?: Partial<DriveArbiterDeps<TestWorld>>): DriveArbiterDeps<TestWorld> {
  return {
    evaluate: () => ({ ...world }),
    act: () => Promise.resolve(),
    isBusy: () => false,
    ...overrides,
  };
}

const world = (heat = 0, now = 0): TestWorld => ({ now, heat });

describe("DriveArbiter", () => {
  it("requires at least one drive", () => {
    expect(() => new DriveArbiter<TestWorld>({ drives: [] })).toThrow(/at least one drive/);
  });

  it("skips when busy", async () => {
    const skips: Array<string> = [];
    const arbiter = new DriveArbiter<TestWorld>({ drives: [fakeDrive("a", { pressure: 1 })], onSkip: (r) => skips.push(r) });
    await arbiter.tick(1, createDeps(world(), { isBusy: () => true }));
    expect(skips).toEqual(["busy"]);
  });

  it("picks the highest-pressure drive", async () => {
    const acts: Array<string> = [];
    const arbiter = new DriveArbiter<TestWorld>({
      drives: [
        fakeDrive("low", { pressure: 0.6 }),
        fakeDrive("high", { pressure: 0.9 }),
      ],
      onAct: (selection) => acts.push(selection.drive.name),
    });

    await arbiter.tick(1, createDeps(world()));
    expect(acts).toEqual(["high"]);
  });

  it("drives read their own senses from a host-defined world", async () => {
    const acts: Array<string> = [];
    const heatDrive = defineDrive<TestWorld>({
      name: "heat",
      threshold: 0.5,
      cooldownMs: 0,
      evaluate: (w) => (w.heat > 80 ? { pressure: 1, prompt: "cool down" } : null),
    });
    const arbiter = new DriveArbiter<TestWorld>({
      drives: [heatDrive],
      onAct: (selection) => acts.push(`${selection.drive.name}:${selection.outcome.prompt}`),
    });

    await arbiter.tick(1, createDeps(world(50)));
    expect(acts).toEqual([]);

    await arbiter.tick(2, createDeps(world(90)));
    expect(acts).toEqual(["heat:cool down"]);
  });

  it("respects per-drive cooldown", async () => {
    let now = 0;
    const acts: Array<string> = [];
    const arbiter = new DriveArbiter<TestWorld>({
      drives: [fakeDrive("a", { pressure: 1, cooldownMs: 1_000 })],
      now: () => now,
      onAct: (selection) => acts.push(selection.drive.name),
    });

    await arbiter.tick(1, createDeps(world()));
    expect(acts).toEqual(["a"]);

    now = 500;
    await arbiter.tick(2, createDeps(world()));
    expect(acts).toEqual(["a"]);

    now = 1_500;
    await arbiter.tick(3, createDeps(world()));
    expect(acts).toEqual(["a", "a"]);
  });

  it("respects min-interval between any two actions", async () => {
    let now = 0;
    const skips: Array<string> = [];
    const arbiter = new DriveArbiter<TestWorld>({
      drives: [fakeDrive("a", { pressure: 1 })],
      minIntervalMs: 500,
      now: () => now,
      onSkip: (reason) => skips.push(reason),
    });

    await arbiter.tick(1, createDeps(world()));
    now = 100;
    await arbiter.tick(2, createDeps(world()));
    expect(skips).toContain("min-interval");
  });

  it("skips when no drive passes threshold", async () => {
    const skips: Array<string> = [];
    const arbiter = new DriveArbiter<TestWorld>({
      drives: [fakeDrive("a", { pressure: 0.3 })],
      onSkip: (reason) => skips.push(reason),
    });
    await arbiter.tick(1, createDeps(world()));
    expect(skips).toEqual(["no-drive-above-threshold"]);
  });

  it("reports every drive evaluation per tick", async () => {
    const reports: Array<Array<string>> = [];
    const arbiter = new DriveArbiter<TestWorld>({
      drives: [
        fakeDrive("hot", { pressure: 0.9 }),
        fakeDrive("cold", { pressure: 0 }),
      ],
      onEvaluated: (evaluations) => reports.push(evaluations.map((e) => `${e.drive.name}:${e.outcome ? e.outcome.pressure : null}:${e.passed}`)),
    });

    await arbiter.tick(1, createDeps(world()));
    expect(reports).toEqual([["hot:0.9:true", "cold:null:false"]]);
  });

  it("marks cooling drives as passed=false but still reports their pressure", async () => {
    let now = 0;
    const reports: Array<Array<string>> = [];
    const acts: Array<string> = [];
    const arbiter = new DriveArbiter<TestWorld>({
      drives: [fakeDrive("a", { pressure: 1, cooldownMs: 1_000 })],
      now: () => now,
      onEvaluated: (evaluations) => reports.push(evaluations.map((e) => `${e.drive.name}:${e.passed}`)),
      onAct: (selection) => acts.push(selection.drive.name),
    });

    await arbiter.tick(1, createDeps(world()));
    now = 500;
    await arbiter.tick(2, createDeps(world()));
    expect(acts).toEqual(["a"]);
    expect(reports).toEqual([["a:true"], ["a:false"]]);
  });
});
