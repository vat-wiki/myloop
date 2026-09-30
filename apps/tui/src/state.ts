export function formatTuiHelp(): string {
  return "Commands: /sessions, /help, /usage, /reset, /exit · Enter runs selection · Tab completes · Ctrl+V pastes · ESC interrupts";
}

export type TuiCommand = {
  command: string;
  description: string;
};

export const tuiCommands: readonly TuiCommand[] = [
  { command: "/sessions", description: "List and switch sessions" },
  { command: "/help", description: "Show help" },
  { command: "/usage", description: "Show latest model usage" },
  { command: "/reset", description: "Clear conversation" },
  { command: "/exit", description: "Exit myloop" },
  { command: "/quit", description: "Exit myloop" },
] as const;

export function getTuiCommandSuggestions(value: string): TuiCommand[] {
  const query = value.trim();
  if (!query.startsWith("/") || /\s/.test(query)) return [];
  return tuiCommands.filter(({ command }) => command.startsWith(query));
}

export function stripControlCharacters(value: string): string {
  return value.replace(/\r/g, "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

export function stringifyResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
