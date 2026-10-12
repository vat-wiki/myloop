import type { CliOptions, ConfigSources } from "./cli.js";

export type StartupStatus = {
  options: CliOptions;
  sources: ConfigSources;
  sessionId: string;
};

export function formatStartupStatus({ options, sources, sessionId }: StartupStatus): string {
  const sourceParts: Array<string> = [];
  if (sources.global) sourceParts.push(`global=${sources.global}`);
  if (sources.project) sourceParts.push(`project=${sources.project}`);
  const thinking = options.protocol === "anthropic"
    ? options.thinking
      ? `enabled${options.thinkingBudgetTokens === undefined ? "" : ` (budget ${options.thinkingBudgetTokens})`}`
      : "disabled"
    : options.thinking
      ? `enabled (effort ${options.reasoningEffort ?? "medium"})`
      : "disabled";

  return [
    `[myloop] config ${sourceParts.length === 0 ? "defaults" : sourceParts.join(" · ")}`,
    `[myloop] model ${options.protocol}/${options.model}`,
    `[myloop] endpoint ${options.baseURL ?? "provider default"}`,
    `[myloop] thinking ${thinking}`,
    `[myloop] session ${sessionId}`,
  ].join("\n");
}
