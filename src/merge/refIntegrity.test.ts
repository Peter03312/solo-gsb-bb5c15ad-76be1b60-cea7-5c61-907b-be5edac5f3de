import { describe, expect, it } from 'vitest';
import { checkRefIntegrity, parseRefConfig, type RefRule } from './refIntegrity';
import type { JsonValue } from './types';

/** 便捷构造一条已解析规则 */
function makeRule(target: string, identity: string, ref: string, index = 1): RefRule {
  const { rules, errors } = parseRefConfig(
    JSON.stringify([{ target, identity, ref }]),
  );
  expect(errors).toEqual([]);
  return { ...rules[0], index };
}

describe('parseRefConfig', () => {
  it('空文本视为无规则', () => {
    expect(parseRefConfig('')).toEqual({ rules: [], errors: [] });
    expect(parseRefConfig('  \n ')).toEqual({ rules: [], errors: [] });
  });

  it('解析合法规则：target / identity / ref，* 段解析为通配', () => {
    const { rules, errors } = parseRefConfig(
      JSON.stringify([
        { target: '/servers', identity: 'id', ref: '/apps/*/serverId' },
        { target: '', identity: 'key', ref: '/a~1b/~0x' },
      ]),
    );
    expect(errors).toEqual([]);
    expect(rules).toHaveLength(2);
    expect(rules[0].index).toBe(1);
    expect(rules[0].targetSegments).toEqual(['servers']);
    expect(rules[0].refSegments).toEqual([
      { type: 'literal', value: 'apps' },
      { type: '*' },
      { type: 'literal', value: 'serverId' },
    ]);
    // 根指针与 RFC 6901 转义
    expect(rules[1].targetSegments).toEqual([]);
    expect(rules[1].refSegments).toEqual([
      { type: 'literal', value: 'a/b' },
      { type: 'literal', value: '~x' },
    ]);
  });

  it('JSON 语法错误 / 非数组配置：整体报错（无规则序号）', () => {
    const bad = parseRefConfig('{oops');
    expect(bad.rules).toEqual([]);
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0].rule).toBeNull();
    expect(bad.errors[0].message).toContain('JSON 解析失败');

    const notArray = parseRefConfig('{"target":"/a"}');
    expect(notArray.errors[0].rule).toBeNull();
    expect(notArray.errors[0].message).toContain('规则数组');
  });

  it('逐条报告非法规则（带规则序号），合法规则仍被解析', () => {
    const { rules, errors } = parseRefConfig(
      JSON.stringify([
        'not-an-object',
        { target: '/a', identity: 'id' },
        { target: '/a', identity: '', ref: '/b' },
        { target: 'no-slash', identity: 'id', ref: '/b' },
        { target: '/a', identity: 'id', ref: '/x~2y' },
        { target: '/ok', identity: 'id', ref: '/refs/*' },
      ]),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].index).toBe(6);
    expect(errors.map((e) => e.rule)).toEqual([1, 2, 3, 4, 5]);
    expect(errors[0].message).toContain('规则必须是对象');
    expect(errors[1].message).toContain('ref 必须是字符串');
    expect(errors[2].message).toContain('identity 必须是非空字符串');
    expect(errors[3].message).toContain('以 / 开头');
    expect(errors[4].message).toContain('非法 RFC 6901 转义');
  });
});

describe('checkRefIntegrity：目标索引', () => {
  it('目标缺失 / 非数组 / 非对象数组元素均报错（带具体路径），且不再求值引用', () => {
    const merged: JsonValue = { a: 1, b: { c: 2 }, d: [{ id: 1 }, 'x'] };
    const result = checkRefIntegrity(merged, [
      makeRule('/missing', 'id', '/refs/*', 1),
      makeRule('/a', 'id', '/refs/*', 2),
      makeRule('/d', 'id', '/refs/*', 3),
    ]);
    expect(result.dangling).toEqual([]);
    expect(result.checked).toBe(0);
    expect(result.errors).toEqual([
      { rule: 1, pointer: '/missing', message: '目标对象数组缺失' },
      { rule: 2, pointer: '/a', message: '目标不是对象数组' },
      { rule: 3, pointer: '/d/1', message: '第 2 项不是对象' },
    ]);
  });

  it('身份缺失 / 类型非法 / 重复均报错（含项位置）', () => {
    const merged: JsonValue = {
      servers: [
        { id: 'a' },
        { name: 'no-id' },
        { id: true },
        { id: 'a' },
        { id: 1 },
        { id: '1' },
      ],
    };
    const result = checkRefIntegrity(merged, [makeRule('/servers', 'id', '/refs/*')]);
    expect(result.errors).toEqual([
      { rule: 1, pointer: '/servers/1', message: '第 2 项缺少身份字段 "id"' },
      { rule: 1, pointer: '/servers/2', message: '第 3 项身份字段 "id" 必须是字符串或数字' },
      { rule: 1, pointer: '/servers/3', message: '第 4 项身份 "a" 与第 1 项重复' },
    ]);
    // 数字 1 与字符串 "1" 按类型区分，不算重复
    expect(result.errors.some((e) => e.pointer === '/servers/5')).toBe(false);
  });

  it('目标为 null 视为非对象数组；根指针可定位根数组', () => {
    const byNull = checkRefIntegrity({ t: null } as JsonValue, [makeRule('/t', 'id', '/r/*')]);
    expect(byNull.errors[0].message).toBe('目标不是对象数组');

    const merged: JsonValue = [{ id: 'x' }];
    const ok = checkRefIntegrity(merged, [makeRule('', 'id', '/0/id')]);
    expect(ok.errors).toEqual([]);
    expect(ok.dangling).toEqual([]);
    expect(ok.checked).toBe(1);
  });
});

describe('checkRefIntegrity：引用路径求值', () => {
  const merged: JsonValue = {
    servers: [
      { id: 's1', weight: 3 },
      { id: 's2', weight: 5 },
    ],
    apps: [
      { name: 'web', serverId: 's1', tags: ['s2', 's1'] },
      { name: 'job', serverId: 's9', tags: [] },
      { name: 'cron', serverId: null, tags: ['s1'] },
      { name: 'batch', serverId: 's2', tags: [] },
    ],
  };

  it('* 段逐层展开数组并保留具体下标；悬空引用带规则序号与具体路径', () => {
    const result = checkRefIntegrity(merged, [
      makeRule('/servers', 'id', '/apps/*/serverId', 1),
      makeRule('/servers', 'id', '/apps/*/tags/*', 2),
    ]);
    // 规则 1：s1 / s2 命中、s9 悬空、null 跳过
    expect(result.dangling).toEqual([
      { rule: 1, pointer: '/apps/1/serverId', value: 's9' },
    ]);
    // 规则 2：tags 展开到具体下标，空数组无引用
    expect(result.errors).toEqual([]);
    expect(result.checked).toBe(3 + 3); // 规则1三个终点（s1、s9、s2）+ 规则2三个终点（s2、s1、s1）
  });

  it('身份按类型区分：数字 1 与字符串 "1" 是不同身份', () => {
    const doc: JsonValue = { servers: [{ id: 1 }], refs: ['1', 1] };
    const result = checkRefIntegrity(doc, [makeRule('/servers', 'id', '/refs/*')]);
    expect(result.dangling).toEqual([{ rule: 1, pointer: '/refs/0', value: '1' }]);
    expect(result.checked).toBe(2);
  });

  it('引用终点为布尔 / 对象 / 数组时报错；中间路径缺失报错；* 遇到非数组报错', () => {
    const doc: JsonValue = {
      servers: [{ id: 'a' }],
      ok: { ref: 'a' },
      bad: [{ ref: true }, { ref: { x: 1 } }, { ref: ['a'] }],
      scalar: 5,
      noRef: { name: 'x' },
    };
    const result = checkRefIntegrity(doc, [
      makeRule('/servers', 'id', '/bad/*/ref', 1),
      makeRule('/servers', 'id', '/scalar/ref/deep', 2),
      makeRule('/servers', 'id', '/noRef/meta/ref', 3),
      makeRule('/servers', 'id', '/ok/*', 4),
    ]);
    expect(result.errors).toEqual([
      { rule: 1, pointer: '/bad/0/ref', message: '引用终点必须是字符串或数字' },
      { rule: 1, pointer: '/bad/1/ref', message: '引用终点必须是字符串或数字' },
      { rule: 1, pointer: '/bad/2/ref', message: '引用终点必须是字符串或数字' },
      { rule: 2, pointer: '/scalar', message: '中间路径缺失：键 "ref" 不存在' },
      { rule: 3, pointer: '/noRef', message: '中间路径缺失：键 "meta" 不存在' },
      { rule: 4, pointer: '/ok', message: '「*」段遇到非数组' },
    ]);
    expect(result.dangling).toEqual([]);
  });

  it('字面量段可按数组下标寻址；越界下标在中间段报错、终点段跳过', () => {
    const doc: JsonValue = {
      servers: [{ id: 'a' }],
      matrix: [[{ ref: 'a' }]],
    };
    const ok = checkRefIntegrity(doc, [makeRule('/servers', 'id', '/matrix/0/0/ref')]);
    expect(ok.errors).toEqual([]);
    expect(ok.checked).toBe(1);

    const mid = checkRefIntegrity(doc, [makeRule('/servers', 'id', '/matrix/5/0/ref')]);
    expect(mid.errors).toEqual([
      { rule: 1, pointer: '/matrix', message: '中间路径缺失：键 "5" 不存在' },
    ]);

    const end = checkRefIntegrity(doc, [makeRule('/servers', 'id', '/matrix/0/9')]);
    expect(end.errors).toEqual([]);
    expect(end.checked).toBe(0);
  });

  it('目标索引有错时跳过该规则的引用求值（不报悬空）', () => {
    const doc: JsonValue = {
      servers: [{ id: 'a' }, { id: 'a' }],
      refs: ['nope'],
    };
    const result = checkRefIntegrity(doc, [makeRule('/servers', 'id', '/refs/*')]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('重复');
    expect(result.dangling).toEqual([]);
    expect(result.checked).toBe(0);
  });

  it('全部命中时无错误：checked 统计引用终点数', () => {
    const doc: JsonValue = {
      servers: [{ id: 'a' }, { id: 2 }],
      refs: [{ ref: 'a' }, { ref: 2 }, { ref: null }, {}],
    };
    const result = checkRefIntegrity(doc, [makeRule('/servers', 'id', '/refs/*/ref')]);
    expect(result.errors).toEqual([]);
    expect(result.dangling).toEqual([]);
    expect(result.checked).toBe(2);
  });
});
