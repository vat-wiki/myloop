export function formatTuiHelp(): string {
  return "Commands: /help, /usage, /reset, /exit";
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
