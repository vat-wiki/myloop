import type { JsonSchemaObject, ToolDefinition } from "../runtime/messages.js";

export type CommandInvocationContext = {
  signal?: AbortSignal;
};

export type CommandHostInput = Record<string, unknown>;

export interface CommandHost<
  TInput extends CommandHostInput = CommandHostInput,
  TResult = unknown,
> {
  readonly id: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  run(input: TInput, context: CommandInvocationContext): Promise<TResult>;
}

export function createCommandHostTool(host: CommandHost): ToolDefinition {
  return {
    name: host.toolName,
    description: host.description,
    parameters: host.inputSchema,
  };
}

export function createCommandHostHandler(
  host: CommandHost,
): (input: CommandHostInput, context: CommandInvocationContext) => Promise<unknown> {
  return (input, context) => host.run(input, context);
}
