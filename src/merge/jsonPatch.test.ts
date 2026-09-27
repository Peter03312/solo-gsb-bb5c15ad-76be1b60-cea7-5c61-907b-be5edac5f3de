import { describe, expect, it } from 'vitest';
import { applyJsonPatch, parseJsonPatch } from './jsonPatch';
import type { JsonValue } from './types';

const BASE: JsonValue = {
  app: 'demo-service',
  version: '1.2.0',
  features: { auth: true, cache: false, logging: { level: 'info' } },
  tags: ['web', 'api'],
  nested: { list: [{ id: 1 }, { id: 2 }] },
  'a/b~c': 1,
};

function applyOk(base: JsonValue, text: string): JsonValue {
  const parsed = parseJsonPatch(text);
  if (!parsed.ok) throw new Error(`解析失败: ${parsed.failure.reason}`);
  const applied = applyJsonPatch(base, parsed.ops);
  if (!applied.ok) throw new Error(`应用失败: ${applied.failure.reason}`);
  return applied.document;
}

describe('parseJsonPatch', () => {
  it('解析合法补丁数组', () => {
    const r = parseJsonPatch('[{"op":"add","path":"/x","value":1}]');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ops).toHaveLength(1);
  });

  it('JSON 语法错误：无操作序号', () => {
    const r = parseJsonPatch('[{bad');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.opIndex).toBeNull();
      expect(r.failure.reason).toContain('JSON 解析失败');
    }
  });

  it('补丁不是数组时给出明确原因', () => {
    const r = parseJsonPatch('{"op":"add","path":"/x","value":1}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.opIndex).toBeNull();
      expect(r.failure.reason).toContain('数组');
    }
  });

  it('结构非法的操作：标明操作序号（从 1 开始）', () => {
    const r = parseJsonPatch('[{"op":"add","path":"/x","value":1},{"op":"delete","path":"/y"}]');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.opIndex).toBe(2);
      expect(r.failure.reason).toContain('op');
    }
  });

  it('move 缺少 from 时校验失败', () => {
    const r = parseJsonPatch('[{"op":"move","path":"/b"}]');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.opIndex).toBe(1);
      expect(r.failure.reason).toContain('from');
    }
  });
});

describe('applyJsonPatch：六种操作', () => {
  it('add：对象新键、数组指定索引与 "-" 追加', () => {
    const doc = applyOk(BASE, `[
      { "op": "add", "path": "/owner", "value": "team-a" },
      { "op": "add", "path": "/tags/1", "value": "v2" },
      { "op": "add", "path": "/tags/-", "value": "end" }
    ]`);
    expect(doc).toEqual({
      ...BASE,
      owner: 'team-a',
      tags: ['web', 'v2', 'api', 'end'],
    });
  });

  it('remove：对象键与数组元素（索引位移）', () => {
    const doc = applyOk(BASE, `[
      { "op": "remove", "path": "/features/cache" },
      { "op": "remove", "path": "/tags/0" }
    ]`);
    expect(doc).toEqual({
      ...BASE,
      features: { auth: true, logging: { level: 'info' } },
      tags: ['api'],
    });
  });

  it('replace：标量、数组元素与整棵子树', () => {
    const doc = applyOk(BASE, `[
      { "op": "replace", "path": "/version", "value": "1.3.0" },
      { "op": "replace", "path": "/tags/0", "value": "web-v2" },
      { "op": "replace", "path": "/features/logging", "value": { "level": "debug" } }
    ]`);
    expect(doc).toEqual({
      ...BASE,
      version: '1.3.0',
      tags: ['web-v2', 'api'],
      features: { auth: true, cache: false, logging: { level: 'debug' } },
    });
  });

  it('move：值被移动且源位置被移除', () => {
    const doc = applyOk(BASE, `[
      { "op": "move", "from": "/features/logging", "path": "/auditLog" }
    ]`);
    expect(doc).toEqual({
      ...BASE,
      features: { auth: true, cache: false },
      auditLog: { level: 'info' },
    });
  });

  it('move：目标父级路径不存在时失败', () => {
    const parsed = parseJsonPatch('[{ "op": "move", "from": "/features/logging", "path": "/audit/logging" }]');
    if (!parsed.ok) throw new Error('should parse');
    const r = applyJsonPatch(BASE, parsed.ops);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.opIndex).toBe(1);
  });

  it('copy：源位置保留，目标为深拷贝', () => {
    const doc = applyOk(BASE, `[
      { "op": "copy", "from": "/features/logging", "path": "/features/auditLog" }
    ]`);
    const features = (doc as Record<string, JsonValue>).features as Record<string, JsonValue>;
    expect(features.logging).toEqual({ level: 'info' });
    expect(features.auditLog).toEqual({ level: 'info' });
    // 深拷贝：修改拷贝结果不影响源
    (features.auditLog as Record<string, JsonValue>).level = 'debug';
    expect((features.logging as Record<string, JsonValue>).level).toBe('info');
  });

  it('test：断言通过则继续，失败则中止并报告序号', () => {
    const ok = applyOk(BASE, `[
      { "op": "test", "path": "/version", "value": "1.2.0" },
      { "op": "replace", "path": "/version", "value": "1.3.0" }
    ]`);
    expect((ok as Record<string, JsonValue>).version).toBe('1.3.0');

    const parsed = parseJsonPatch(`[
      { "op": "replace", "path": "/version", "value": "9.9.9" },
      { "op": "test", "path": "/version", "value": "1.2.0" }
    ]`);
    if (!parsed.ok) throw new Error('should parse');
    const applied = applyJsonPatch(BASE, parsed.ops);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.failure.opIndex).toBe(2);
      expect(applied.failure.reason).toContain('test');
    }
  });

  it('根路径替换（path 为 ""）', () => {
    const doc = applyOk(BASE, '[{ "op": "replace", "path": "", "value": [1, 2] }]');
    expect(doc).toEqual([1, 2]);
  });

  it('RFC 6901 转义路径段（~0 与 ~1）', () => {
    const doc = applyOk(BASE, '[{ "op": "replace", "path": "/a~1b~0c", "value": 2 }]');
    expect((doc as Record<string, JsonValue>)['a/b~c']).toBe(2);
  });
});

describe('applyJsonPatch：失败与隔离性', () => {
  it('remove 不存在的路径：报告失败序号与原因', () => {
    const parsed = parseJsonPatch(`[
      { "op": "replace", "path": "/version", "value": "1.3.0" },
      { "op": "remove", "path": "/features/nope" }
    ]`);
    if (!parsed.ok) throw new Error('should parse');
    const r = applyJsonPatch(BASE, parsed.ops);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.opIndex).toBe(2);
      expect(r.failure.reason).toContain('路径不存在');
    }
  });

  it('数组索引越界与非法索引', () => {
    const outOfBounds = parseJsonPatch('[{ "op": "add", "path": "/tags/9", "value": "x" }]');
    if (!outOfBounds.ok) throw new Error('should parse');
    const r1 = applyJsonPatch(BASE, outOfBounds.ops);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.failure.opIndex).toBe(1);

    const illegal = parseJsonPatch('[{ "op": "remove", "path": "/tags/abc" }]');
    if (!illegal.ok) throw new Error('should parse');
    const r2 = applyJsonPatch(BASE, illegal.ops);
    expect(r2.ok).toBe(false);
  });

  it('move 的 from 不存在时失败', () => {
    const parsed = parseJsonPatch('[{ "op": "move", "from": "/nope", "path": "/x" }]');
    if (!parsed.ok) throw new Error('should parse');
    const r = applyJsonPatch(BASE, parsed.ops);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toContain('from');
  });

  it('应用失败或成功后基线均保持不变；两份补丁作用于同一基线的独立副本', () => {
    const base: JsonValue = JSON.parse(JSON.stringify(BASE)) as JsonValue;
    const ours = parseJsonPatch('[{ "op": "replace", "path": "/version", "value": "ours" }]');
    const theirs = parseJsonPatch('[{ "op": "replace", "path": "/version", "value": "theirs" }]');
    if (!ours.ok || !theirs.ok) throw new Error('should parse');

    const docOurs = applyJsonPatch(base, ours.ops);
    const docTheirs = applyJsonPatch(base, theirs.ops);
    expect(docOurs.ok && (docOurs.document as Record<string, JsonValue>).version).toBe('ours');
    expect(docTheirs.ok && (docTheirs.document as Record<string, JsonValue>).version).toBe('theirs');
    // 基线未被任何一次应用修改
    expect(base).toEqual(BASE);

    // 失败的一侧同样不污染基线
    const bad = parseJsonPatch('[{ "op": "remove", "path": "/app" }, { "op": "remove", "path": "/nope" }]');
    if (!bad.ok) throw new Error('should parse');
    expect(applyJsonPatch(base, bad.ops).ok).toBe(false);
    expect(base).toEqual(BASE);
  });

  it('示例补丁可将示例基线还原为示例分支文档', async () => {
    const { SAMPLE_BASE, SAMPLE_OURS, SAMPLE_THEIRS, SAMPLE_OURS_PATCH, SAMPLE_THEIRS_PATCH } =
      await import('../sampleData');
    const base = JSON.parse(SAMPLE_BASE) as JsonValue;
    expect(applyOk(base, SAMPLE_OURS_PATCH)).toEqual(JSON.parse(SAMPLE_OURS));
    expect(applyOk(base, SAMPLE_THEIRS_PATCH)).toEqual(JSON.parse(SAMPLE_THEIRS));
  });
});
