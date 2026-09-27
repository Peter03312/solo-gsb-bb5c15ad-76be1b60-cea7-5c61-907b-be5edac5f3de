// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import DecisionTracePanel from './DecisionTracePanel';
import { buildMerged, threeWayMerge, type Resolutions } from '../merge/threeWayMerge';
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

function setup(
  base: JsonValue,
  ours: JsonValue,
  theirs: JsonValue,
  resolutions: Resolutions = {},
) {
  const result = threeWayMerge(base, ours, theirs);
  const merged = buildMerged(result.root, resolutions) as JsonValue;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const render = makeRenderer(container);
  act(() => {
    render(<DecisionTracePanel mergeResult={result} resolutions={resolutions} merged={merged} />);
  });
  return { container, result, merged };
}

/** 校验决策溯源报告内容（/a 仅目标删除场景） */
function verifyReport(text: string) {
  const report = JSON.parse(text);
  expect(report.format).toBe('json-three-way-merge/decision-trace');
  expect(report.summary.total).toBe(1);
  expect(report.summary.remove).toBe(1);
  expect(report.summary.bySource['theirs-only']).toBe(1);
  const item = report.entries[0];
  expect(item.pointer).toBe('/a');
  expect(item.base).toEqual({ present: true, value: 1 });
  expect(item.ours).toEqual({ present: true, value: 1 });
  expect(item.theirs).toEqual({ present: false });
  expect(item.final).toEqual({ present: false });
}

describe('DecisionTracePanel', () => {
  it('列出全部变更路径与来源徽标，删除条目保留', () => {
    // /o 仅当前改、/t 仅目标改、/same 双方同改、/gone 仅当前删除
    const base: JsonValue = { o: 1, t: 1, same: 1, gone: 1 };
    const ours: JsonValue = { o: 2, t: 1, same: 9 };
    const theirs: JsonValue = { o: 1, t: 3, same: 9, gone: 1 };
    const { container } = setup(base, ours, theirs);

    expect(h(container, '.trace-summary')?.textContent).toContain('4');
    const rows = all(container, '.trace-row');
    expect(rows.map((r) => r.querySelector('.trace-path')?.textContent)).toEqual([
      '/o',
      '/t',
      '/same',
      '/gone',
    ]);
    expect(rows[0].querySelector('.trace-source')?.textContent).toContain('仅当前分支');
    expect(rows[3].querySelector('.trace-change')?.textContent).toBe('删除');
  });

  it('点击路径展开详情：基线 / 当前 / 目标 / 最终值，缺失标注（不存在）', () => {
    // /a 仅当前删除（目标不动）：当前侧与最终值缺失
    const { container } = setup({ a: 1, b: 2 }, { b: 2 }, { a: 1, b: 2 });
    const row = all(container, '.trace-row').find((r) =>
      r.querySelector('.trace-path')?.textContent?.startsWith('/a'),
    )!;
    act(() => (row as HTMLButtonElement).click());

    const detail = h(container, '.trace-detail')!;
    expect(detail).not.toBeNull();
    expect(h(detail, '.trace-detail-pointer')?.textContent).toBe('/a');
    const blocks = all(detail, '.trace-value pre').map((p) => p.textContent);
    expect(blocks).toEqual(['1', '（不存在）', '1', '（不存在）']);
    expect(h(detail, '.trace-change')?.textContent).toBe('删除');
  });

  it('冲突解决按采用当前 / 目标 / 自定义归类', () => {
    const { container } = setup(
      { a: 1, b: 1, c: 1 },
      { a: 2, b: 2, c: 2 },
      { a: 3, b: 3, c: 3 },
      { c0: { kind: 'ours' }, c1: { kind: 'theirs' }, c2: { kind: 'custom', value: 99 } },
    );
    const texts = all(container, '.trace-row').map((r) => r.querySelector('.trace-source')?.textContent);
    expect(texts.some((t) => t?.includes('采用当前'))).toBe(true);
    expect(texts.some((t) => t?.includes('采用目标'))).toBe(true);
    expect(texts.some((t) => t?.includes('自定义'))).toBe(true);

    // 自定义项详情显示最终值 99
    const customRow = all(container, '.trace-row').find((r) =>
      r.querySelector('.trace-source')?.textContent?.includes('自定义'),
    )!;
    act(() => (customRow as HTMLButtonElement).click());
    const blocks = all(container, '.trace-detail .trace-value pre').map((p) => p.textContent);
    expect(blocks).toEqual(['1', '2', '3', '99']);
  });

  it('按来源筛选：仅显示被选中类别，计数为 0 的类别按钮禁用', () => {
    const { container } = setup({ a: 1, b: 2 }, { a: 9, b: 2 }, { a: 1, b: 2 });
    expect(all(container, '.trace-row')).toHaveLength(1);
    const oursChip = btnByText(container, '仅当前分支')!;
    const theirsChip = btnByText(container, '仅目标分支')!;
    expect(theirsChip.disabled).toBe(true);
    act(() => oursChip.click());
    expect(all(container, '.trace-row')).toHaveLength(1);
    // 再点开一个空类别（计数为 0 的已禁用，改用“双方同改”确认禁用）
    expect(btnByText(container, '双方同改')!.disabled).toBe(true);
  });

  it('下载决策溯源报告：JSON 含分类汇总、三方值与缺失标注', () => {
    // /a 仅目标删除
    const { container } = setup({ a: 1, b: 2 }, { a: 1, b: 2 }, { b: 2 });
    let captured = '';
    const createObjectURL = vi.fn().mockImplementation((blob: Blob) => {
      // 直接从 Blob 的内部字符串块取回内容（jsdom Blob 保存传入的字符串）
      captured = (blob as unknown as { parts?: string[] }).parts?.join('') ?? '';
      return 'blob:mock';
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    act(() => btnByText(container, 'decision-trace.json')!.click());

    // 上面的内部字段在不同 jsdom 版本不可靠时，退回 FileReader 异步读取
    if (!captured) {
      const calls = createObjectURL.mock.calls as unknown as Blob[][];
      const blob = calls[0][0];
      return new Promise<void>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          verifyReport(String(reader.result));
          vi.unstubAllGlobals();
          resolve();
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
      });
    }
    verifyReport(captured);
    vi.unstubAllGlobals();
  });

  it('父对象整体替换只列父路径；数组整体替换只列数组路径', () => {
    const { container: c1 } = setup(
      { a: { x: 1, y: 2 } },
      { a: { z: 9 } },
      { a: { x: 1, y: 2 } },
    );
    expect(all(c1, '.trace-row').map((r) => r.querySelector('.trace-path')?.textContent)).toEqual([
      '/a',
    ]);

    const { container: c2 } = setup({ list: [1, 2] }, { list: [3] }, { list: [1, 2] });
    expect(all(c2, '.trace-row').map((r) => r.querySelector('.trace-path')?.textContent)).toEqual([
      '/list',
    ]);
  });

  it('返回调整后以新 props 重新渲染：清单随最新决策重新生成', () => {
    const base: JsonValue = { a: 1 };
    const ours: JsonValue = { a: 2 };
    const theirs: JsonValue = { a: 3 };
    const result = threeWayMerge(base, ours, theirs);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const render = makeRenderer(container);

    const renderWith = (res: Resolutions) => {
      const merged = buildMerged(result.root, res) as JsonValue;
      render(<DecisionTracePanel mergeResult={result} resolutions={res} merged={merged} />);
    };

    act(() => renderWith({ c0: { kind: 'ours' } }));
    let source = h(container, '.trace-row .trace-source')?.textContent;
    expect(source).toContain('采用当前');
    expect(h(container, '.trace-row .trace-path')?.textContent).toBe('/a');

    // 改选目标分支后重新生成
    act(() => renderWith({ c0: { kind: 'theirs' } }));
    source = h(container, '.trace-row .trace-source')?.textContent;
    expect(source).toContain('采用目标');

    // 自定义回基线值 → 无变更条目
    act(() => renderWith({ c0: { kind: 'custom', value: 1 } }));
    expect(h(container, '.trace-row')).toBeNull();
    expect(h(container, '.trace-summary')?.textContent).toContain('0');
  });

  it('根节点冲突解决时显示（根）路径', () => {
    const { container } = setup(1, 2, 3, { c0: { kind: 'ours' } });
    expect(h(container, '.trace-row .trace-path')?.textContent).toBe('（根）');
  });
});
