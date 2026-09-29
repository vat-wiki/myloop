import type { AgentLogEvent, AgentLogger } from "myanne/runtime";

export type TuiLogEvent = AgentLogEvent;
export type TuiLogger = AgentLogger;

export {
  createAppLogger as createTuiLogger,
  type AppLoggerOptions as TuiLoggerOptions,
} from "@myanne/app-sdk";
