import type { NamedAgent } from "./composite.js";
import type { Agent, AgentResult, DelegationRecord } from "./types.js";

export type AgentSessionOptions = {
  name: string;
  perception: Agent;
  brain: Agent;
  hands?: Array<NamedAgent>;
  maxDelegations?: number;
};

export type AgentSessionResult = AgentResult & {
  name: string;
  input: string;
  perception: string;
  delegations: Array<DelegationRecord>;
};

export type AgentSessionStatus = "active" | "closed";

type DelegationInstruction = {
  worker: string;
  input: string;
};

type BrainInstruction =
  | { action: "delegate"; delegations: Array<DelegationInstruction> }
  | { action: "finish"; answer: string };

export class AgentSession {
  readonly name: string;
  readonly perception: Agent;
  readonly brain: Agent;
  readonly maxDelegations: number;

  #hands = new Map<string, NamedAgent>();
  #status: AgentSessionStatus = "active";
  #processing = false;

  constructor({ name, perception, brain, hands = [], maxDelegations = 10 }: AgentSessionOptions) {
    if (!name.trim()) {
      throw new Error("agent session name is required");
    }
    if (!Number.isInteger(maxDelegations) || maxDelegations < 1) {
      throw new Error("maxDelegations must be a positive integer");
    }

    for (const hand of hands) {
      this.#validateHand(hand);
      this.#hands.set(hand.name, hand);
    }

    this.name = name;
    this.perception = perception;
    this.brain = brain;
    this.maxDelegations = maxDelegations;
  }

  get hands(): ReadonlyArray<NamedAgent> {
    return [...this.#hands.values()];
  }

  get status(): AgentSessionStatus {
    return this.#status;
  }

  get processing(): boolean {
    return this.#processing;
  }

  hasHand(name: string): boolean {
    return this.#hands.has(name);
  }

  getHand(name: string): NamedAgent | undefined {
    return this.#hands.get(name);
  }

  registerHand(hand: NamedAgent): void {
    this.#assertRosterMutable();
    this.#validateHand(hand);
    this.#hands.set(hand.name, hand);
  }

  unregisterHand(name: string): boolean {
    this.#assertRosterMutable();
    return this.#hands.delete(name);
  }

  async send(input: string): Promise<AgentSessionResult> {
    if (this.#status === "closed") {
      throw new Error("agent session is closed");
    }
    if (this.#processing) {
      throw new Error("agent session is already processing a message");
    }
    if (!input.trim()) {
      throw new Error("agent session input is required");
    }

    this.#processing = true;
    try {
      const perceptionResult = await this.perception.run(input);
      const perception = perceptionResult.answer;
      const delegations: Array<DelegationRecord> = [];
      let workingAnswer: string | undefined;

      while (workingAnswer === undefined) {
        const brainInput = delegations.length === 0
          ? renderBrainInput({
            input,
            perception,
            hands: this.hands,
            maxDelegations: this.maxDelegations,
          })
          : renderBrainFollowUpInput({ delegations });

        const brainResult = await this.brain.run(brainInput);
        const instruction = parseInstruction(brainResult.answer);

        if (instruction.action === "finish") {
          workingAnswer = instruction.answer;
          continue;
        }

        const remainingDelegations = this.maxDelegations - delegations.length;
        if (instruction.delegations.length > remainingDelegations) {
          throw new Error(`agent session exceeded maxDelegations: ${this.maxDelegations}`);
        }

        const batch = await Promise.all(
          instruction.delegations.map(async (delegation) => {
            const hand = this.#hands.get(delegation.worker);
            if (!hand) {
              throw new Error(`unknown hand: ${delegation.worker}`);
            }

            const result = await hand.agent.run(delegation.input);
            return {
              worker: hand.name,
              input: delegation.input,
              output: result.answer,
            } satisfies DelegationRecord;
          }),
        );

        delegations.push(...batch);
      }

      const responseResult = await this.perception.run(renderResponseInput(workingAnswer));

      return {
        name: this.name,
        input,
        perception,
        answer: responseResult.answer,
        delegations,
        response: responseResult.response,
      };
    } finally {
      this.#processing = false;
    }
  }

  abort(reason?: unknown): void {
    this.perception.abort(reason);
    this.brain.abort(reason);
    for (const hand of this.hands) {
      hand.agent.abort(reason);
    }
  }

  reset(): void {
    if (this.#processing) {
      throw new Error("cannot reset agent session while processing");
    }

    this.perception.reset?.();
    this.brain.reset?.();
    for (const hand of this.hands) {
      hand.agent.reset?.();
    }
  }

  #validateHand(hand: NamedAgent): void {
    if (!hand.name.trim()) {
      throw new Error("hand name is required");
    }
    if (this.#hands.has(hand.name)) {
      throw new Error(`duplicate hand name: ${hand.name}`);
    }
  }

  #assertRosterMutable(): void {
    if (this.#processing) {
      throw new Error("cannot change agent session hands while processing");
    }
    if (this.#status === "closed") {
      throw new Error("agent session is closed");
    }
  }

  close(): void {
    if (this.#processing) {
      throw new Error("cannot close agent session while processing");
    }

    this.#status = "closed";
  }
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  return new AgentSession(options);
}

function renderBrainInput({
  input,
  perception,
  hands,
  maxDelegations,
}: {
  input: string;
  perception: string;
  hands: ReadonlyArray<NamedAgent>;
  maxDelegations: number;
}): string {
  const handList = hands
    .map((hand) => `- ${hand.name}: ${hand.description}`)
    .join("\n");

  return `
User message:
${input}

Important information collected by perception:
${perception}

Available hands:
${handList}

Delegation budget: ${maxDelegations}

You are the brain. Decide what work is needed and delegate to the appropriate hands. Do not perform specialist work yourself.
Return exactly one JSON object and no other text.
To delegate work, return:
{"action":"delegate","delegations":[{"worker":"hand-name","input":"instructions for the hand"}]}
To finish, return:
{"action":"finish","answer":"working answer"}
`.trim();
}

function renderBrainFollowUpInput({
  delegations,
}: {
  delegations: ReadonlyArray<DelegationRecord>;
}): string {
  const delegationList = delegations
    .map((delegation, index) => `${index + 1}. ${delegation.worker}\nInput: ${delegation.input}\nOutput: ${delegation.output}`)
    .join("\n\n");

  return `
Hand results:
${delegationList}

Decide whether more work is needed. If the working answer is ready, finish.
Return exactly one JSON object and no other text.
`.trim();
}

function renderResponseInput(workingAnswer: string): string {
  return `
Internal working result:
${workingAnswer}

Turn this into the final response for the user.
`.trim();
}

function parseInstruction(text: string): BrainInstruction {
  const value = parseJsonObject(text);
  if (value.action === "delegate") {
    if (!Array.isArray(value.delegations)) {
      throw new Error("brain delegation batch must be an array");
    }

    const delegations: Array<DelegationInstruction> = [];
    for (const item of value.delegations) {
      if (!isRecord(item) || typeof item.worker !== "string" || typeof item.input !== "string") {
        throw new Error("invalid brain delegation instruction");
      }
      delegations.push({ worker: item.worker, input: item.input });
    }

    if (delegations.length === 0) {
      throw new Error("brain delegation batch cannot be empty");
    }

    return { action: "delegate", delegations };
  }

  if (value.action === "finish" && typeof value.answer === "string") {
    return { action: "finish", answer: value.answer };
  }

  throw new Error("brain must return a delegate or finish instruction");
}

function parseJsonObject(text: string): Record<string, unknown> {
  const value = parseJson(extractJson(text));
  if (!isRecord(value)) {
    throw new Error("brain must return a JSON object");
  }
  return value;
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("brain response does not contain a JSON object");
  }
  return trimmed.slice(start, end + 1);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("brain response is not valid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
