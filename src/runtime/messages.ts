export type JsonSchemaObject = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export type TextBlock = {
  type: "text";
  text: string;
};

export type BinarySource =
  | { type: "url"; url: string }
  | { type: "artifact"; artifactId: string }
  | { type: "base64"; data: string };

export type ImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

export type ImageBlock = {
  type: "image";
  mediaType: ImageMediaType;
  source: BinarySource;
};

export type DocumentBlock = {
  type: "document";
  mediaType: "application/pdf";
  title?: string;
  source: BinarySource;
};

export type VideoMediaType =
  | "video/mp4"
  | "video/webm"
  | "video/quicktime";

export type VideoBlock = {
  type: "video";
  mediaType: VideoMediaType;
  source: BinarySource;
};

export type ToolCallBlock = {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolResultBlock = {
  type: "tool_result";
  toolCallId: string;
  content: unknown;
  isError?: boolean;
};

export type UserContentBlock = TextBlock | ImageBlock | DocumentBlock | VideoBlock;
export type AgentContentBlock =
  | TextBlock
  | ImageBlock
  | DocumentBlock
  | VideoBlock
  | ToolCallBlock
  | ToolResultBlock;
export type MessageRole = "user" | "assistant" | "tool";

export type AgentMessage = {
  role: MessageRole;
  content: Array<AgentContentBlock>;
};

export type StopReason = "end" | "tool_call";

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
};

export function textBlock(text: string): TextBlock {
  return { type: "text", text };
}

export function imageBlock(
  mediaType: ImageMediaType,
  source: BinarySource,
): ImageBlock {
  return { type: "image", mediaType, source };
}

export function documentBlock(
  source: BinarySource,
  title?: string,
): DocumentBlock {
  return title === undefined
    ? { type: "document", mediaType: "application/pdf", source }
    : { type: "document", mediaType: "application/pdf", title, source };
}

export function videoBlock(
  mediaType: VideoMediaType,
  source: BinarySource,
): VideoBlock {
  return { type: "video", mediaType, source };
}

export function toolCallBlock(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): ToolCallBlock {
  return { type: "tool_call", id, name, arguments: args };
}

export function toolResultBlock(
  toolCallId: string,
  content: unknown,
  isError = false,
): ToolResultBlock {
  return { type: "tool_result", toolCallId, content, isError };
}

export function normalizeContent(content: string | Array<AgentContentBlock>): Array<AgentContentBlock> {
  if (typeof content === "string") {
    return [textBlock(content)];
  }
  return content;
}

export function createUserMessage(
  content: string | Array<UserContentBlock>,
): AgentMessage {
  return { role: "user", content: normalizeContent(content) };
}

export function createAssistantMessage(content: Array<AgentContentBlock>): AgentMessage {
  return { role: "assistant", content: normalizeContent(content) };
}

export function createToolMessage(results: Array<ToolResultBlock>): AgentMessage {
  return { role: "tool", content: results };
}
