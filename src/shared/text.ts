/**
 * Finds a line exactly equal to `marker` in a text and returns its start offset, or -1 if absent.
 *
 * Matches whole lines only: `marker` must span from the start through the end of a line, so the same
 * string inside body text is not mistaken for a marker line. `from` continues after the previous match.
 */
export function indexOfWholeLine(text: string, marker: string, from = 0): number {
  let index = from;
  while (index < text.length) {
    const found = text.indexOf(marker, index);
    if (found < 0) return -1;
    const atLineStart = found === 0 || text[found - 1] === "\n";
    const after = found + marker.length;
    const atLineEnd = after === text.length || text[after] === "\n" ||
      text.startsWith("\r\n", after);
    if (atLineStart && atLineEnd) return found;
    index = found + marker.length;
  }
  return -1;
}
