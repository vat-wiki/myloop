import type { AgentContentBlock, ModelResponse, UserContentBlock } from "../runtime/index.js";
import { textBlock } from "../runtime/messages.js";
import type { UserInput } from "../runtime/user-input.js";
import {
  createUserInputAdapter,
  isUserInputAdapter,
  type UserInputAdapterOptions,
  type UserInputResolver,
} from "../runtime/user-input.js";
import type { Agent, AgentResult, DelegationRecord } from "./types.js";

export type NamedAgent = {
  name: string;
  description: string;
  agent: Agent;
};

export type CompositeAgentOptions = {
  name: string;
  coordinator: Agent;
  workers: Array<NamedAgent>;
  maxDelegations?: number;
  input?: UserInputResolver | UserInputAdapterOptions;
};

export type DelegationInstruction = {
  worker: string;
  input: string;
};

export type CompositeAgentResult = AgentResult & {
  name: string;
  input: UserInput;
  delegations: Array<DelegationRecord>;
};

type CoordinatorInstruction =
  | { action: "delegate"; delegations: Array<DelegationInstruction> }
  | { action: "finish"; answer: string };

export class CompositeAgent implements Agent {
  readonly name: string;
  readonly coordinator: Agent;
  readonly workers: ReadonlyArray<NamedAgent>;
  readonly maxDelegations: number;
  readonly input: UserInputResolver;

  constructor({
    name,
    coordinator,
    workers,
    maxDelegations = 10,
    input,
  }: CompositeAgentOptions) {
    if (!name.trim()) {
      throw new Error("composite agent name is required");
    }
    if (workers.length === 0) {
      throw new Error("composite agent requires at least one worker");
    }
    if (!Number.isInteger(maxDelegations) || maxDelegations < 1) {
      throw new Error("maxDelegations must be a positive integer");
    }

    const workerNames = new Set<string>();
    for (const worker of workers) {
      if (!worker.name.trim()) {
        throw new Error("worker name is required");
      }
      if (workerNames.has(worker.name)) {
        throw new Error(`duplicate worker name: ${worker.name}`);
      }
      workerNames.add(worker.name);
    }

    this.name = name;
    this.coordinator = coordinator;
    this.workers = workers;
    this.maxDelegations = maxDelegations;
    this.input = isUserInputAdapter(input) ? input : createUserInputAdapter(input);
  }

  async run(input: UserInput): Promise<CompositeAgentResult> {
    if (typeof input === "string" && !input.trim()) {
      throw new Error("composite agent input is required");
    }

    const inputBlocks = await this.input.resolve(input);
    if (inputBlocks.length === 0) {
      throw new Error("composite agent input is required");
    }

    const delegations: Array<DelegationRecord> = [];
    let coordinatorInput = renderCoordinatorInput({
      task: inputBlocks,
      workers: this.workers,
      delegations,
      maxDelegations: this.maxDelegations,
    });

    while (true) {
      const coordinatorResult = await this.coordinator.run(coordinatorInput);
      const coordinatorText = responseText(coordinatorResult.response.content);
      const instruction = parseInstruction(coordinatorText);

      if (instruction.action === "finish") {
        return {
          name: this.name,
          input,
          answer: instruction.answer,
          delegations,
          response: coordinatorResult.response,
        };
      }

      if (instruction.delegations.length === 0) {
        throw new Error("delegation batch cannot be empty");
      }

      const remainingDelegations = this.maxDelegations - delegations.length;
      if (instruction.delegations.length > remainingDelegations) {
        throw new Error(`composite agent exceeded maxDelegations: ${this.maxDelegations}`);
      }

      const workerNames = new Set<string>();
      for (const delegation of instruction.delegations) {
        if (workerNames.has(delegation.worker)) {
          throw new Error(`duplicate worker in delegation batch: ${delegation.worker}`);
        }
        workerNames.add(delegation.worker);
      }

      const batchRecords = await Promise.all(
        instruction.delegations.map(async (delegation) => {
          const worker = this.workers.find((candidate) => candidate.name === delegation.worker);
          if (!worker) {
            throw new Error(`unknown worker: ${delegation.worker}`);
          }

          const workerResult = await worker.agent.run(delegation.input);
          return {
            worker: worker.name,
            input: delegation.input,
            output: workerResult.answer,
          } satisfies DelegationRecord;
        }),
      );

      delegations.push(...batchRecords);
      coordinatorInput = renderCoordinatorInput({
        task: inputBlocks,
        workers: this.workers,
        delegations,
        latestDelegations: batchRecords,
        maxDelegations: this.maxDelegations,
      });
    }
  }

  reset(): void {
    this.coordinator.reset?.();
    for (const worker of this.workers) {
      worker.agent.reset?.();
    }
  }

  abort(reason?: unknown): void {
    this.coordinator.abort(reason);
    for (const worker of this.workers) {
      worker.agent.abort(reason);
    }
  }
}

export function createCompositeAgent({
  name,
  coordinator,
  workers,
  maxDelegations = 10,
  input,
}: CompositeAgentOptions): CompositeAgent {
  return new CompositeAgent({ name, coordinator, workers, maxDelegations, input });
}

function renderCoordinatorInput({
  task,
  workers,
  delegations,
  latestDelegations,
  maxDelegations,
}: {
  task: ReadonlyArray<UserContentBlock>;
  workers: ReadonlyArray<NamedAgent>;
  delegations: ReadonlyArray<DelegationRecord>;
  latestDelegations?: ReadonlyArray<DelegationRecord>;
  maxDelegations: number;
}): Array<UserContentBlock> {
  const workerList = workers
    .map((worker) => `- ${worker.name}: ${worker.description}`)
    .join("\n");
  const delegationList = delegations.length === 0
    ? "none"
    : delegations
      .map((delegation, index) => `${index + 1}. ${delegation.worker}: ${delegation.input}`)
      .join("\n");
  const latestOutputs = latestDelegations === undefined || latestDelegations.length === 0
    ? ""
    : `\n## Latest worker outputs\n${latestDelegations
      .map((delegation) => `[${delegation.worker}]\n${delegation.output}`)
      .join("\n\n")}`;
  const remainingDelegations = maxDelegations - delegations.length;

  const taskText = task
    .filter((block): block is Extract<UserContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const instruction = `
## Task
${taskText || "See attached user content."}
## Workers
${workerList}

Remaining delegation budget: ${remainingDelegations}

## Previous delegations
${delegationList}
${latestOutputs}

You coordinate these workers. Do not exceed the remaining delegation budget. If no delegation is useful, finish.
Return exactly one JSON object and no other text.
To delegate to one worker, return:
{"action":"delegate","delegations":[{"worker":"worker-name","input":"instructions for the worker"}]}
To delegate to multiple workers in parallel, return:
{"action":"delegate","delegations":[{"worker":"first-worker","input":"..."},{"worker":"second-worker","input":"..."}]}
To finish, return: {"action":"finish","answer":"final answer"}
`.trim();

  return [...task, textBlock(instruction)];
}

function parseInstruction(text: string): CoordinatorInstruction {
  const json = extractJson(text);
  if (!json) {
    return { action: "finish", answer: text.trim() };
  }

  const parsed = JSON.parse(json) as unknown;
  if (!isRecord(parsed)) {
    return { action: "finish", answer: text.trim() };
  }

  if (parsed.action === "finish" && typeof parsed.answer === "string") {
    return { action: "finish", answer: parsed.answer };
  }

  if (
    parsed.action === "delegate"
  ) {
    const rawDelegations = parsed.delegations;
    if (Array.isArray(rawDelegations)) {
      const delegations: Array<DelegationInstruction> = [];
      for (const rawDelegation of rawDelegations) {
        if (!isRecord(rawDelegation)) continue;
        if (typeof rawDelegation.worker !== "string") continue;
        if (typeof rawDelegation.input !== "string") continue;
        delegations.push({
          worker: rawDelegation.worker,
          input: rawDelegation.input,
        });
      }

      if (delegations.length > 0) {
        return { action: "delegate", delegations };
      }
    }

    if (typeof parsed.worker === "string" && typeof parsed.input === "string") {
      return {
        action: "delegate",
        delegations: [{ worker: parsed.worker, input: parsed.input }],
      };
    }
  }

  return { action: "finish", answer: text.trim() };
}

function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end < start) {
    return null;
  }
  return candidate.slice(start, end + 1);
}

function responseText(content: Array<AgentContentBlock>): string {
  return content
    .filter((block): block is Extract<AgentContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
