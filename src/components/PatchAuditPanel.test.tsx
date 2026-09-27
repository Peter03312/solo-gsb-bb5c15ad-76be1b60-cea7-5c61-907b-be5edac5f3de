// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import PatchAuditPanel from './PatchAuditPanel';
import OutputStage from './OutputStage';
import { diff } from '../merge/rfc6902';
import { threeWayMerge } from '../merge/threeWayMerge';
import type { JsonValue } from '../merge/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeRenderer(container: HTMLElement) {
  const root = createRoot(container);
  return (node: ReactElement) => act(() => root.render(node));
}

const h = (container: ParentNode, sel: string) => container.querySelector(sel);
const all = (container: ParentNode, sel: string) => [...container.querySelectorAll(sel)];
const btnByText = (container: HTMLElement, text: string) =>
  all(container, 'button').find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

/** React 受控组件需要用原生 setter 赋值后再派发 input 事件 */
function typeInto(container: HTMLElement, sel: string, v: string) {
  const ta = h(container, sel) as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(ta, v);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

const BASE: JsonValue = { version: '1.0.0', a: 1 };
const MERGED: JsonValue = { version: '2.0.0', a: 1, b: 2 };

function setup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const onCopy = vi.fn();
  const render = makeRenderer(container);
  act(() => {
    render(<PatchAuditPanel base={BASE} merged={MERGED} autoPatch={diff(BASE, MERGED)} onCopy={onCopy} />);
  });
  return { container, onCopy };
}

describe('PatchAuditPanel', () => {
  it('加载时即填入自动生成补丁；直接审计显示通过', () => {
    const { container } = setup();
    const ta = h(container, '.audit-input') as HTMLTextAreaElement;
    expect(JSON.parse(ta.value)).toEqual(diff(BASE, MERGED));
    expect(h(container, '.audit-result')).toBeNull();

    act(() => btnByText(container, '审计补丁')!.click());
    const result = h(container, '.audit-result.pass');
    expect(result).not.toBeNull();
    expect(result!.textContent).toContain('审计通过');
  });

  it('编辑为应用失败的补丁：显示从 1 开始的操作序号与原因', () => {
    const { container } = setup();
    act(() => typeInto(container, '.audit-input', '[{"op":"remove","path":"/nope"}]'));
    act(() => btnByText(container, '审计补丁')!.click());

    const result = h(container, '.audit-result.fail')!;
    expect(result.textContent).toContain('回放失败');
    expect(result.textContent).toContain('1');
    expect(result.textContent).toContain('路径不存在');
    expect(h(container, '.audit-result.pass')).toBeNull();
  });

  it('第二个操作失败：序号为 2（test 断言失败）', () => {
    const { container } = setup();
    act(() =>
      typeInto(
        container,
        '.audit-input',
        JSON.stringify([
          { op: 'replace', path: '/version', value: 'x' },
          { op: 'test', path: '/version', value: '1.0.0' },
        ]),
      ),
    );
    act(() => btnByText(container, '审计补丁')!.click());
    const result = h(container, '.audit-result.fail')!;
    expect(result.querySelector('.op-index')?.textContent).toBe('2');
    expect(result.textContent).toContain('test');
  });

  it('回放成功但与合并结果不同：显示首个差异指针、期望值与实际值', () => {
    const { container } = setup();
    act(() => typeInto(container, '.audit-input', '[{"op":"replace","path":"/version","value":"3.0.0"}]'));
    act(() => btnByText(container, '审计补丁')!.click());

    const result = h(container, '.audit-result.mismatch')!;
    expect(result.textContent).toContain('不一致');
    expect(result.querySelector('code')?.textContent).toBe('/version');
    const blocks = all(result, 'pre');
    expect(blocks[0].textContent).toBe('"2.0.0"'); // 期望（合并结果）
    expect(blocks[1].textContent).toBe('"3.0.0"'); // 实际（回放结果）
  });

  it('缺少键时实际值显示（不存在），指针指向缺失键', () => {
    const { container } = setup();
    // 只改 version，不 add /b → /b 在回放结果中缺失
    act(() => typeInto(container, '.audit-input', '[{"op":"replace","path":"/version","value":"2.0.0"}]'));
    act(() => btnByText(container, '审计补丁')!.click());
    const result = h(container, '.audit-result.mismatch')!;
    expect(result.querySelector('code')?.textContent).toBe('/b');
    expect(all(result, 'pre')[1].textContent).toBe('（不存在）');
  });

  it('补丁 JSON 非法：显示格式错误，无操作序号', () => {
    const { container } = setup();
    act(() => typeInto(container, '.audit-input', '[{bad'));
    act(() => btnByText(container, '审计补丁')!.click());
    const result = h(container, '.audit-result.fail')!;
    expect(result.textContent).toContain('格式非法');
    expect(result.textContent).toContain('JSON 解析失败');
  });

  it('重置：恢复自动生成补丁文本并清除审计结论与修改标记', () => {
    const { container } = setup();
    const autoText = (h(container, '.audit-input') as HTMLTextAreaElement).value;

    act(() => typeInto(container, '.audit-input', '[{"op":"remove","path":"/nope"}]'));
    expect(h(container, '.audit-dirty')?.textContent).toContain('已修改');
    act(() => btnByText(container, '审计补丁')!.click());
    expect(h(container, '.audit-result.fail')).not.toBeNull();

    act(() => btnByText(container, '重置为自动补丁')!.click());
    expect((h(container, '.audit-input') as HTMLTextAreaElement).value).toBe(autoText);
    expect(h(container, '.audit-result')).toBeNull();
    expect(h(container, '.audit-dirty')).toBeNull();
    // 重置后重新审计通过
    act(() => btnByText(container, '审计补丁')!.click());
    expect(h(container, '.audit-result.pass')).not.toBeNull();
  });

  it('复制按钮复制的是当前编辑文本；编辑后出现修改提示', () => {
    const { container, onCopy } = setup();
    const edited = '[{"op":"replace","path":"/a","value":42}]';
    act(() => typeInto(container, '.audit-input', edited));
    act(() => btnByText(container, '复制')!.click());
    expect(onCopy).toHaveBeenCalledWith(edited, '审计补丁 ');
  });

  it('下载按钮存在（下载当前编辑文本，不阻断）', () => {
    const { container } = setup();
    expect(btnByText(container, '下载 audit-patch.json')).toBeDefined();
  });

  it('编辑内容后旧审计结论自动失效（再次编辑清除结论）', () => {
    const { container } = setup();
    act(() => typeInto(container, '.audit-input', '[{"op":"remove","path":"/nope"}]'));
    act(() => btnByText(container, '审计补丁')!.click());
    expect(h(container, '.audit-result.fail')).not.toBeNull();
    act(() => typeInto(container, '.audit-input', '[]'));
    expect(h(container, '.audit-result')).toBeNull();
  });
});

describe('补丁审计与合并结果隔离（OutputStage 集成）', () => {
  it('审计编辑与失败回放不修改合并结果视图与自动补丁面板', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const render = makeRenderer(container);
    act(() => {
      render(
        <OutputStage
          base={BASE}
          merged={MERGED}
          patch={diff(BASE, MERGED)}
          mergeResult={threeWayMerge(BASE, MERGED, BASE)}
          resolutions={{}}
          schemaEnabled={false}
          schema={null}
          onSchemaEnabledChange={() => {}}
          onSchemaChange={() => {}}
          protectedConfig=""
          onProtectedConfigChange={() => {}}
          refCheckEnabled={false}
          refCheckConfig=""
          onRefCheckEnabledChange={() => {}}
          onRefCheckConfigChange={() => {}}
          onBack={() => {}}
          onRestart={() => {}}
        />,
      );
    });

    const mergedBefore = h(container, '.output-panel .json-lines')!.textContent;
    const autoPatchBefore = all(container, '.output-panel pre')[0].textContent;

    // 在审计面板写入一个会失败的补丁并审计
    act(() => typeInto(container, '.audit-input', '[{"op":"remove","path":"/nope"}]'));
    act(() => btnByText(container, '审计补丁')!.click());
    expect(h(container, '.audit-result.fail')).not.toBeNull();

    // 合并结果视图与自动补丁面板内容不变
    expect(h(container, '.output-panel .json-lines')!.textContent).toBe(mergedBefore);
    expect(all(container, '.output-panel pre')[0].textContent).toBe(autoPatchBefore);
    expect(h(container, '.output-panel .json-lines')!.textContent).toContain('"version": "2.0.0"');

    // 再写一个回放成功但值不同的补丁，合并结果依旧不变
    act(() => typeInto(container, '.audit-input', '[{"op":"replace","path":"/version","value":"9.9.9"}]'));
    act(() => btnByText(container, '审计补丁')!.click());
    expect(h(container, '.audit-result.mismatch')).not.toBeNull();
    expect(h(container, '.output-panel .json-lines')!.textContent).toBe(mergedBefore);
  });
});
