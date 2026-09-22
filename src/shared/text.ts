/**
 * 在一段文本里找整行等于 `marker` 的那一行，返回行首位置；找不到返回 -1。
 *
 * 只认整行匹配：`marker` 必须从行首开始、到行尾结束，所以正文里出现同样的字符串
 * 不会被误判成标记行。`from` 用于从上一次命中之后继续找。
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
