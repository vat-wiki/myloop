export const INLINE_OUTPUT_LIMIT = 10_000;
export const TAIL_LINE_LIMIT = 200;

export function formatCommandOutput(text: string): string {
  const source = text.trimEnd();
  if (!source) return "(empty)";
  if (source.length <= INLINE_OUTPUT_LIMIT) return source;

  const lines = source.split("\n").slice(-TAIL_LINE_LIMIT);
  const kept: string[] = [];
  let used = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const separator = kept.length > 0 ? 1 : 0;
    if (used + separator + line.length <= INLINE_OUTPUT_LIMIT) {
      kept.unshift(line);
      used += separator + line.length;
      continue;
    }

    if (used === 0) {
      kept.unshift(line.slice(-INLINE_OUTPUT_LIMIT));
    }
    break;
  }

  return kept.join("\n");
}
