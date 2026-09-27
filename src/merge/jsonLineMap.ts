import { toPointer } from './pointer';

/**
 * 扫描 JSON 文本，建立「JSON Pointer → 起始行号（0 起）」映射。
 *
 * 行号对应标准缩进渲染（JSON.stringify(value, null, 2)）中该值第一个 token 所在行，
 * 与输入文本本身的排版无关（紧凑 JSON 同样适用）。
 *
 * 递归规则：
 *   - 标量 / 空容器：仅占起始行；
 *   - 非空容器：第一个成员在 startLine + 1；后续成员在上一个成员结束行的下一行。
 * walk 返回该值最后一个成员所在行（即闭合括号所在行）。
 */
export function buildPointerLines(text: string): Map<string, number> {
  const lines = new Map<string, number>();
  let pos = 0;

  const skipWs = () => {
    while (pos < text.length && /\s/.test(text[pos])) pos++;
  };

  const parseString = (): string => {
    // 调用方已确认 text[pos] === '"'
    const start = pos;
    pos++;
    while (pos < text.length) {
      const ch = text[pos++];
      if (ch === '\\') pos++;
      else if (ch === '"') return JSON.parse(text.slice(start, pos)) as string;
    }
    throw new Error('未闭合的字符串');
  };

  /** 跳过一个非容器值（字符串 / 数字 / true / false / null） */
  const skipLiteral = () => {
    const start = pos;
    if (text[pos] === '"') {
      parseString();
      return;
    }
    while (pos < text.length && !/[\s,{}\[\]]/.test(text[pos])) pos++;
    if (pos === start) throw new Error(`意外的字符: ${text[pos]}`);
  };

  const walk = (segments: string[], startLine: number): number => {
    skipWs();
    lines.set(toPointer(segments), startLine);
    const ch = text[pos];
    if (ch !== '{' && ch !== '[') {
      skipLiteral();
      return startLine;
    }

    const open = ch;
    const close = open === '{' ? '}' : ']';
    pos++;
    skipWs();
    if (text[pos] === close) {
      pos++;
      return startLine; // 空容器只占一行
    }

    let memberLine = startLine + 1;
    let prevEnd: number | null = null;
    let index = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      skipWs();
      let key: string | null = null;
      if (open === '{') {
        if (text[pos] !== '"') throw new Error('对象键必须是字符串');
        key = parseString();
        skipWs();
        if (text[pos] !== ':') throw new Error('缺少冒号');
        pos++;
      }
      const childSegs = open === '{' ? [...segments, key!] : [...segments, String(index)];
      const endLine = walk(childSegs, memberLine);
      prevEnd = endLine;
      index++;
      skipWs();
      if (text[pos] === ',') {
        pos++;
        memberLine = prevEnd + 1;
        continue;
      }
      if (text[pos] === close) {
        pos++;
        return endLine + 1; // 容器自身最后一行是闭合括号
      }
      throw new Error('缺少逗号或闭合符号');
    }
  };

  walk([], 0);
  return lines;
}

/**
 * 将 instancePath 映射到渲染行号；无法精确定位时回退到最长的已存在祖先路径
 * （例如 /a 的 required 错误发生在缺失键上，回退到 /a 所在行）。
 */
export function resolveLine(lines: Map<string, number>, instancePath: string): number | null {
  if (lines.has(instancePath)) return lines.get(instancePath)!;
  const segs = instancePath.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  while (segs.length > 0) {
    segs.pop();
    const pointer = toPointer(segs);
    if (lines.has(pointer)) return lines.get(pointer)!;
  }
  return lines.get('') ?? null;
}
