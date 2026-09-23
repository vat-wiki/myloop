import type { ToolHandler } from "./agent.js";
import type { ToolDefinition } from "./messages.js";
import type { ModelRequest, ModelResponse } from "./model-client.js";

export type AgentTool = {
  name: string;
  definition: ToolDefinition;
  handler: ToolHandler;
};

export type AgentExtension = {
  name: string;
  beforeModelCall?: (request: ModelRequest) => ModelRequest | Promise<ModelRequest>;
  afterModelResponse?: (input: {
    request: ModelRequest;
    response: ModelResponse;
  }) => ModelResponse | Promise<ModelResponse>;
  wrapToolCall?: (tool: AgentTool) => ToolHandler | void;
};
