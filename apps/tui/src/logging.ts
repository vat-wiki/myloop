import type {
  AgentDiagnosticEvent,
  AgentLogEvent,
  AgentLogger,
  AgentLogLevel,
} from "myloop/runtime";

export type TuiLogEvent = AgentLogEvent;
export type TuiDiagnosticEvent = AgentDiagnosticEvent;
export type TuiLogger = AgentLogger;

export {
  createAppLogger as createTuiLogger,
  type AppLoggerOptions as TuiLoggerOptions,
  type AgentLogLevel as TuiLogLevel,
} from "@myloop/app-sdk";
