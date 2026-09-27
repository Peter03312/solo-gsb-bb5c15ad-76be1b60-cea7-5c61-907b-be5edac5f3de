// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import MergeStage from './MergeStage';
import { threeWayMerge, type Resolutions } from '../merge/threeWayMerge';
import {
  initHistory,
  resolutionHistoryReducer,
  type ResolutionHistoryState,
  type TransactionKind,
} from '../merge/history';
import type { JsonValue } from '../merge/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 未实现 scrollIntoView（合并树定位冲突时会调用）
Element.prototype.scrollIntoView = function scrollIntoView() {};

function makeRenderer(container: HTMLElement) {
  const root = createRoot(container);
  return (node: ReactElement) => act(() => root.render(node));
}

const h = (container: HTMLElement, sel: string) => container.querySelector(sel);
const all = (container: HTMLElement, sel: string) => [...container.querySelectorAll(sel)];
const btnByText = (container: HTMLElement, text: string) =>
  all(container, 'button').find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

/** React 受控组件需要用原生 setter 赋值后再派发 input 事件 */
function typeInto(input: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function mergeWithServiceConflicts() {
  const base: JsonValue = { services: { api: { name: 'n', port: 80 } }, meta: 1 };
  const ours: JsonValue = { services: { api: { name: 'ours-name', port: 81 } }, meta: 2 };
  const theirs: JsonValue = { services: { api: { name: 'theirs-name', port: 82 } }, meta: 3 };
  return threeWayMerge(base, ours, theirs);
}

function setup(initial: Resolutions = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const mergeResult = mergeWithServiceConflicts();
  expect(mergeResult.conflicts.map((c) => c.pointer)).toEqual([
    '/services/api/name',
    '/services/api/port',
    '/meta',
  ]);

  let history: ResolutionHistoryState = initHistory(initial);
  const render = makeRenderer(container);
  const rerender = () => {
    const canUndo = history.past.length > 0;
    const canRedo = history.future.length > 0;
    render(
      <MergeStage
        mergeResult={mergeResult}
        resolutions={history.present}
        onCommit={(kind: TransactionKind, next: Resolutions) => {
          const prevLength = history.past.length;
          history = resolutionHistoryReducer(history, { type: 'commit', kind, next });
          rerender();
          return history.past.length > prevLength ? history.past[history.past.length - 1] : null;
        }}
        onUndo={() => {
          const tx = history.past[history.past.length - 1] ?? null;
          history = resolutionHistoryReducer(history, { type: 'undo' });
          rerender();
          return tx;
        }}
        onRedo={() => {
          const tx = history.future[0] ?? null;
          history = resolutionHistoryReducer(history, { type: 'redo' });
          rerender();
          return tx;
        }}
        canUndo={canUndo}
        canRedo={canRedo}
        undoTransaction={canUndo ? history.past[history.past.length - 1] : null}
        redoTransaction={canRedo ? history.future[0] : null}
        onFinish={() => {}}
        onBack={() => {}}
        restoreInfo={null}
      />,
    );
  };
  rerender();
  return { container, getResolutions: () => history.present, mergeResult };
}

describe('MergeStage 批量决策规则集成', () => {
  it('预览命中数量、单列多规则重叠、点击路径定位冲突', () => {
    const { container } = setup();

    const inputs = () => all(container, '.batch-pattern-input') as HTMLInputElement[];
    act(() => typeInto(inputs()[0], '/services/*/name'));

    // 第一条规则命中 1 个冲突
    expect(h(container, '.batch-hit-badge')?.textContent).toContain('命中 1');

    // 添加第二条规则并选择“采用目标分支”
    act(() => btnByText(container, '添加规则')!.click());
    act(() => typeInto(inputs()[1], '/services/**'));
    act(() => {
      const select = all(container, '.batch-choice-select')[1] as HTMLSelectElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'theirs');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // 规则 1 命中 2 个冲突（name、port）
    const badges = all(container, '.batch-hit-badge');
    expect(badges[1].textContent).toContain('命中 2');

    // 重叠区单列 /services/api/name，并标注命中规则 #1 #2
    const overlap = h(container, '.batch-overlap') as HTMLElement;
    expect(overlap).not.toBeNull();
    expect(overlap.textContent).toContain('/services/api/name');
    expect(all(overlap, '.rule-no').map((n) => n.textContent)).toEqual(['#1', '#2']);
    expect(overlap.textContent).not.toContain('/services/api/port');

    // “本次将处理”数量为 2（name、port；/meta 无命中）
    expect(h(container, '.batch-will-apply')?.textContent).toContain('2');

    // 点击重叠区路径定位到该冲突
    act(() => {
      all(overlap, '.hit-pointer')
        .find((p) => p.textContent?.includes('/services/api/name'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      h(container, '.conflict-detail .pointer')?.textContent,
    ).toContain('/services/api/name');
  });

  it('非法模式就地报错并阻止应用', () => {
    const { container } = setup();
    const inputs = () => all(container, '.batch-pattern-input') as HTMLInputElement[];

    act(() => typeInto(inputs()[0], 'no-leading-slash'));
    expect(h(container, '.batch-row-error')?.textContent).toContain('必须以 / 开头');
    expect(btnByText(container, '应用规则')?.disabled).toBe(true);
    expect(h(container, '.batch-blocked')?.textContent).toContain('非法模式');

    // 改成合法模式后解除阻止
    act(() => typeInto(inputs()[0], '/services/*/name'));
    expect(h(container, '.batch-row-error')).toBeNull();
    expect(btnByText(container, '应用规则')?.disabled).toBe(false);

    // 非法 ~ 转义同样阻止应用
    act(() => btnByText(container, '添加规则')!.click());
    act(() => typeInto(inputs()[1], '/a~2b'));
    expect(h(container, '.batch-row-error')?.textContent).toContain('RFC 6901');
    expect(btnByText(container, '应用规则')?.disabled).toBe(true);
  });

  it('应用时自上而下取首条命中，只处理未选择冲突，不覆盖已有选择，之后可逐项改选', () => {
    // 冲突 id 依 DFS 顺序分配，先用一次合并结果按指针取得稳定 id
    const probe = mergeWithServiceConflicts();
    const idOf = (pointer: string) => probe.conflicts.find((c) => c.pointer === pointer)!.id;
    const nameId = idOf('/services/api/name');
    const portId = idOf('/services/api/port');
    const metaId = idOf('/meta');

    // 预置：name 冲突已手动选择 theirs
    const { container, getResolutions } = setup({ [nameId]: { kind: 'theirs' } });

    const inputs = () => all(container, '.batch-pattern-input') as HTMLInputElement[];
    act(() => typeInto(inputs()[0], '/services/*/name')); // ours
    act(() => btnByText(container, '添加规则')!.click());
    act(() => typeInto(inputs()[1], '/services/**')); // theirs
    act(() => {
      const select = all(container, '.batch-choice-select')[1] as HTMLSelectElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'theirs');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // 预览：首条规则命中 1 个但已选择（待处理 0）；本次只处理 1 个（port）
    const badges = all(container, '.batch-hit-badge');
    expect(badges[0].textContent).toContain('待处理 0');
    expect(h(container, '.batch-will-apply')?.textContent).toContain('1');

    act(() => btnByText(container, '应用规则')!.click());

    const resolutions = getResolutions();
    // 已有选择未被覆盖（仍是 theirs，而非规则 1 的 ours）
    expect(resolutions[nameId]).toEqual({ kind: 'theirs' });
    // port 由第二条规则处理为 theirs；/meta 无命中仍未选择
    expect(resolutions[portId]).toEqual({ kind: 'theirs' });
    expect(resolutions[metaId]).toBeUndefined();

    // 结果提示 1 项处理、1 项跳过
    const result = h(container, '.batch-result')?.textContent;
    expect(result).toContain('1');
    expect(result).toContain('未覆盖');

    // 应用后仍可逐项改选：在冲突面板把当前冲突（自动跳到 /meta）选为当前分支
    act(() => btnByText(container, '采用当前分支')!.click());
    expect(getResolutions()[metaId]).toEqual({ kind: 'ours' });
  });
});
