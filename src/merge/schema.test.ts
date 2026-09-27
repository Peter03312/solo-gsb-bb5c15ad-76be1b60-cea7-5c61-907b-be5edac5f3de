import { describe, expect, it } from 'vitest';
import { buildPointerLines, resolveLine } from './jsonLineMap';
import {
  compileSchema,
  countIssues,
  SchemaCompileError,
  SchemaParseError,
  validateMerged,
} from './schema';

describe('compileSchema', () => {
  it('接受合法的 Draft 2020-12 Schema 并校验通过', () => {
    const s = compileSchema(JSON.stringify({ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }));
    expect(validateMerged(s, { id: 'x' })).toEqual([]);
  });

  it('Schema JSON 无法解析时抛出 SchemaParseError，且不影响既有 Schema', () => {
    const prev = compileSchema('{"type":"number"}');
    expect(() => compileSchema('{not json')).toThrow(SchemaParseError);
    // 上一份 Schema 仍可正常使用
    expect(validateMerged(prev, 3)).toEqual([]);
  });

  it('包含无法解析的本地 $ref 时抛出带明确提示的 SchemaCompileError', () => {
    expect(() => compileSchema(JSON.stringify({ $ref: '#/$defs/missing' }))).toThrow(
      /无法解析的本地 \$ref：#\/\$defs\/missing/,
    );
    // 非法 Schema：type 必须是字符串或字符串数组
    expect(() => compileSchema(JSON.stringify({ type: 1 }))).toThrow(SchemaCompileError);
  });

  it('支持文档内 $ref 解析', () => {
    const s = compileSchema(
      JSON.stringify({
        type: 'object',
        properties: { child: { $ref: '#/$defs/item' } },
        $defs: { item: { type: 'integer' } },
      }),
    );
    const groups = validateMerged(s, { child: 1.5 });
    expect(groups[0].instancePath).toBe('/child');
    expect(groups[0].issues[0].keyword).toBe('type');
  });

  it('errors 按 instancePath 分组，携带 keyword / message / params', () => {
    const s = compileSchema(
      JSON.stringify({
        type: 'object',
        required: ['id', 'missing'],
        properties: { id: { type: 'string' }, tag: { enum: ['a', 'b'] } },
      }),
    );
    const groups = validateMerged(s, { id: 1, tag: 'c' });
    // 根路径：required（id 存在但 missing 缺失）；/id：type；/tag：enum
    expect(groups).toHaveLength(3);
    // 根路径：required，参数含 missingProperty
    const root = groups.find((g) => g.instancePath === '')!;
    expect(root.issues[0].keyword).toBe('required');
    expect(root.issues[0].params.missingProperty).toBe('missing');
    // /id：type 错误
    expect(groups.find((g) => g.instancePath === '/id')!.issues[0].message).toMatch(/string/);
    // /tag：enum，参数含 allowedValues
    expect(groups.find((g) => g.instancePath === '/tag')!.issues[0].params).toMatchObject({
      allowedValues: ['a', 'b'],
    });
    expect(countIssues(groups)).toBe(3);
  });

  it('支持 ajv-formats 提供的 format 校验', () => {
    const s = compileSchema(JSON.stringify({ type: 'string', format: 'email' }));
    expect(validateMerged(s, 'nope')[0].issues[0].keyword).toBe('format');
    expect(validateMerged(s, 'a@b.com')).toEqual([]);
  });
});

describe('buildPointerLines', () => {
  const doc = {
    name: 'x',
    meta: { version: 1, nested: { deep: [10, { ok: true }] } },
    'a/b~c': 0,
    list: [{ k: 1 }],
  };
  const text = JSON.stringify(doc, null, 2);

  it('指针映射到缩进渲染中的起始行', () => {
    const lines = buildPointerLines(text);
    const rendered = text.split('\n');
    expect(rendered[lines.get('')!]).toMatch(/^{/);
    expect(rendered[lines.get('/name')!].trim()).toBe('"name": "x",');
    expect(rendered[lines.get('/meta')!].trim()).toBe('"meta": {');
    expect(rendered[lines.get('/meta/version')!].trim()).toBe('"version": 1,');
    expect(rendered[lines.get('/meta/nested/deep')!].trim()).toBe('"deep": [');
    expect(rendered[lines.get('/meta/nested/deep/0')!].trim()).toBe('10,');
    expect(rendered[lines.get('/meta/nested/deep/1/ok')!].trim()).toBe('"ok": true');
    expect(rendered[lines.get('/a~1b~0c')!].trim()).toBe('"a/b~c": 0,');
    expect(rendered[lines.get('/list/0/k')!].trim()).toBe('"k": 1');
  });

  it('与输入排版无关（紧凑 JSON 也能映射到缩进行）', () => {
    const pretty = buildPointerLines(text);
    const compact = buildPointerLines(JSON.stringify(doc));
    expect([...compact.entries()].sort()).toEqual([...pretty.entries()].sort());
  });

  it('标量根文档位于第 0 行', () => {
    expect(buildPointerLines('42').get('')).toBe(0);
    expect(buildPointerLines('  "hi" ').get('')).toBe(0);
  });

  it('空对象与空数组只记录根', () => {
    const m1 = buildPointerLines('{}');
    expect(m1.get('')).toBe(0);
    expect(m1.size).toBe(1);
    const m2 = buildPointerLines('[]');
    expect(m2.size).toBe(1);
  });

  it('resolveLine 对缺失键回退到最近祖先', () => {
    const lines = buildPointerLines(text);
    // /meta/nested/deep/1/ok 存在
    expect(resolveLine(lines, '/meta/nested/deep/1/ok')).toBe(lines.get('/meta/nested/deep/1/ok'));
    // 不存在的指针回退到 /meta
    expect(resolveLine(lines, '/meta/missing')).toBe(lines.get('/meta'));
    expect(resolveLine(lines, '/nope')).toBe(lines.get(''));
  });
});
