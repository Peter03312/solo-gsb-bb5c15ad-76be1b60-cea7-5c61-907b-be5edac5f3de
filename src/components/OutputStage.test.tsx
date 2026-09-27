// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import OutputStage from './OutputStage';
import type { CompiledSchema } from '../merge/schema';
import { compileSchema } from '../merge/schema';
import { threeWayMerge } from '../merge/threeWayMerge';
import type { JsonValue } from '../merge/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeRenderer(container: HTMLElement) {
  const root = createRoot(container);
  return (node: ReactElement) => act(() => root.render(node));
}

const h = (container: HTMLElement, sel: string) => container.querySelector(sel);
const all = (container: HTMLElement, sel: string) => [...container.querySelectorAll(sel)];
const btnByText = (container: HTMLElement, text: string) =>
  all(container, 'button').find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

/** 以 base 为基线、merged 为当前分支改动（目标分支不动）构造合并结果，溯源全部归为“仅当前分支” */
function traceProps(base: JsonValue, merged: JsonValue) {
  return { mergeResult: threeWayMerge(base, merged, base), resolutions: {} };
}

/** React 受控组件需要用原生 setter 赋值后再派发 input 事件 */
function typeIntoSchema(container: HTMLElement, v: string) {
  const ta = h(container, '.schema-input') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(ta, v);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('OutputStage Schema 校验集成', () => {
  const baseProps = {
    base: { id: 0 } as unknown as JsonValue,
    merged: { id: 1, tag: 'c' } as unknown as JsonValue,
    patch: [],
    ...traceProps({ id: 0 } as unknown as JsonValue, { id: 1, tag: 'c' } as unknown as JsonValue),
    protectedConfig: '',
    onProtectedConfigChange: () => {},
    refCheckEnabled: false,
    refCheckConfig: '',
    onRefCheckEnabledChange: () => {},
    onRefCheckConfigChange: () => {},
    onBack: () => {},
    onRestart: () => {},
  };

  it('默认无校验；开启后应用 Schema，错误分组显示并警示，仍可下载，点击路径触发行定位', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    let enabled = false;
    let schema: CompiledSchema | null = null;
    const render = makeRenderer(container);
    const rerender = () =>
      render(
        <OutputStage
          {...baseProps}
          schemaEnabled={enabled}
          schema={schema}
          onSchemaEnabledChange={(v) => {
            enabled = v;
            rerender();
          }}
          onSchemaChange={(s) => {
            schema = s;
            rerender();
          }}
        />,
      );
    rerender();

    // 初始：有开关但无 Schema 输入区、无警示
    expect(h(container, '.schema-panel')?.textContent).toContain('JSON Schema 约束校验');
    expect(h(container, '.schema-input')).toBeNull();
    expect(h(container, '.download-warn')).toBeNull();

    // 勾选开启
    act(() => (h(container, '.schema-toggle input') as HTMLInputElement).click());
    expect(h(container, '.schema-input')).not.toBeNull();

    // 输入 Schema 并应用：id 需为 string，tag 枚举 a/b，missing 必填
    act(() =>
      typeIntoSchema(
        container,
        JSON.stringify({
          type: 'object',
          required: ['id', 'missing'],
          properties: { id: { type: 'string' }, tag: { enum: ['a', 'b'] } },
        }),
      ),
    );
    act(() => btnByText(container, '应用 Schema')!.click());

    // 校验摘要：3 个错误、3 个分组
    expect(h(container, '.validation-summary')?.textContent).toContain('3');
    expect(all(container, '.issue-group')).toHaveLength(3);

    // 根分组展示 required 关键字与 missingProperty 参数
    const rootGroup = all(container, '.issue-group').find((g) =>
      g.querySelector('.issue-pointer')?.textContent?.includes('（根）'),
    )!;
    expect(rootGroup.querySelector('.keyword')?.textContent).toBe('required');
    expect(rootGroup.querySelector('.params')?.textContent).toContain('missing');

    // 下载旁警示存在，且按钮本身未禁用（有错误仍可下载）
    expect(h(container, '.download-warn')?.textContent).toContain('3 个校验错误');
    expect(btnByText(container, '下载 merged.json')?.disabled).toBe(false);

    // 点击 /tag 路径：对应值所在行高亮
    act(() => {
      const pointer = all(container, '.issue-pointer').find((p) =>
        p.textContent?.startsWith('/tag'),
      )!;
      pointer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(h(container, '.json-line.hit')?.textContent).toContain('"tag": "c"');

    // 关闭校验：错误列表与警示消失
    act(() => (h(container, '.schema-toggle input') as HTMLInputElement).click());
    expect(h(container, '.validation-box')).toBeNull();
    expect(h(container, '.download-warn')).toBeNull();
    // 重新开启后仍沿用已编译 Schema
    act(() => (h(container, '.schema-toggle input') as HTMLInputElement).click());
    expect(all(container, '.issue-group')).toHaveLength(3);
  });

  it('Schema 解析失败 / $ref 无法解析时提示错误且不覆盖上一份有效 Schema', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let schema: CompiledSchema | null = compileSchema('{"type":"object"}');
    const render = makeRenderer(container);
    const rerender = () =>
      render(
        <OutputStage
          {...baseProps}
          merged={{} as JsonValue}
          schemaEnabled
          schema={schema}
          onSchemaEnabledChange={() => {}}
          onSchemaChange={(s) => {
            schema = s;
            rerender();
          }}
        />,
      );
    rerender();
    expect(h(container, '.validation-summary.ok')?.textContent).toContain('符合');

    // JSON 语法错误
    act(() => typeIntoSchema(container, '{bad'));
    act(() => btnByText(container, '应用 Schema')!.click());
    expect(h(container, '.error-text')?.textContent).toContain('解析失败');
    // 旧 Schema 仍生效：通过提示仍在
    expect(h(container, '.validation-summary.ok')).not.toBeNull();

    // 无法解析的本地 $ref
    act(() => typeIntoSchema(container, '{"$ref":"#/$defs/nope"}'));
    act(() => btnByText(container, '应用 Schema')!.click());
    expect(h(container, '.error-text')?.textContent).toContain('无法解析的本地 $ref');
    expect(h(container, '.error-text')?.textContent).toContain('#/$defs/nope');
    // 仍然沿用旧 Schema
    expect(h(container, '.validation-summary.ok')).not.toBeNull();
    expect(schema?.text).toBe('{\n  "type": "object"\n}');
  });
});
