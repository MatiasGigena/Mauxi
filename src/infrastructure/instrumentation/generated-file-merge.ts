/** Remove known generator edits while retaining independent user edits.
 * Ambiguous/overlapping regions are conflicts, never a whole-file restore.
 */
export function removeGeneratedChanges(current: string, generated: string, before: string): string {
  if (current.startsWith(generated)) return before + current.slice(generated.length);
  const lines = (value: string) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const from = lines(generated), to = lines(before);
  if (from.length > 256 || to.length > 8192) throw new Error("Generated-file merge exceeds its bounded line budget");
  const lengths = Array.from({ length: from.length + 1 }, () => new Uint32Array(to.length + 1));
  for (let i = from.length - 1; i >= 0; i--) {
    for (let j = to.length - 1; j >= 0; j--) lengths[i][j] = from[i] === to[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  }
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  let i = 0, j = 0;
  while (i < from.length || j < to.length) {
    if (i < from.length && j < to.length && from[i] === to[j]) { i++; j++; continue; }
    const start = i;
    const replacement: string[] = [];
    while (i < from.length || j < to.length) {
      if (i < from.length && j < to.length && from[i] === to[j]) break;
      if (j < to.length && (i === from.length || lengths[i][j + 1] >= lengths[i + 1][j])) replacement.push(to[j++]);
      else i++;
    }
    edits.push({ start, end: i, replacement: replacement.join("") });
  }
  let result = current;
  for (const edit of edits.reverse()) {
    const removed = from.slice(edit.start, edit.end).join("");
    if (removed) {
      const index = result.indexOf(removed);
      if (index < 0 || result.indexOf(removed, index + removed.length) >= 0) throw new Error("Generated changes overlap with user edits");
      result = result.slice(0, index) + edit.replacement + result.slice(index + removed.length);
    } else {
      const left = from[edit.start - 1] ?? "";
      const right = from[edit.start] ?? "";
      const anchor = left + right;
      const index = result.indexOf(anchor);
      if (!anchor || index < 0 || result.indexOf(anchor, index + anchor.length) >= 0) throw new Error("Generated insertion has no unambiguous anchor");
      const at = index + left.length;
      result = result.slice(0, at) + edit.replacement + result.slice(at);
    }
  }
  return result;
}
