import type { AgentLogEvent, AgentLogger } from "mycoder/runtime";

export type TuiLogEvent = AgentLogEvent;
export type TuiLogger = AgentLogger;

export {
  createAppLogger as createTuiLogger,
  type AppLoggerOptions as TuiLoggerOptions,
} from "@mycoder/app-sdk";
