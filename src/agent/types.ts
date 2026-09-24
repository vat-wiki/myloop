import type {
  ModelResponse,
} from "../runtime/index.js";
import type { UserInput } from "../runtime/user-input.js";

export type AgentResult = {
  answer: string;
  response: ModelResponse;
  delegations?: ReadonlyArray<DelegationRecord>;
};

export type DelegationRecord = {
  worker: string;
  input: string;
  output: string;
};

export type Agent = {
  readonly name: string;
  run(input: UserInput): Promise<AgentResult>;
  abort(reason?: unknown): void;
  reset?(): void;
};
