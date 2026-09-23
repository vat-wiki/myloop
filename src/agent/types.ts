import type {
  ImageMediaType,
  ModelResponse,
  UserContentBlock,
} from "../runtime/index.js";

export type AgentInputPart =
  | { type: "text"; text: string }
  | { type: "imageFile"; path: string; mediaType?: ImageMediaType }
  | { type: "documentFile"; path: string; title?: string }
  | { type: "imageUrl"; url: string; mediaType?: ImageMediaType }
  | { type: "documentUrl"; url: string; title?: string };

export type AgentUserInput =
  | string
  | UserContentBlock
  | AgentInputPart
  | ReadonlyArray<string | UserContentBlock | AgentInputPart>;

export type AgentRunInput = AgentUserInput;

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
  run(input: string): Promise<AgentResult>;
  abort(reason?: unknown): void;
  reset?(): void;
};
