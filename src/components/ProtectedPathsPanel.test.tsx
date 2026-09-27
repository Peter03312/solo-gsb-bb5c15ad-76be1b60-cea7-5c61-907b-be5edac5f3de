// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import OutputStage from './OutputStage';
import { diff } from '../merge/rfc6902';
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

/** React 受控组件需要用原生 setter 赋值后再派发 input 事件 */
function typeInto(container: HTMLElement, sel: string, v: string) {
  const ta = h(container, sel) as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(ta, v);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

const BASE: JsonValue = { svc: { pwd: 'x', name: 'a' }, keep: 1 };
const OURS: JsonValue = { svc: { pwd: 'y', name: 'a' }, keep: 1, extra: true };

/** base → ours 单边修改（theirs 不动）：/svc/pwd 修改、/extra 新增，来源均为「仅当前分支」 */
function stageProps() {
  return {
    base: BASE,
    merged: OURS,
    patch: diff(BASE, OURS),
    mergeResult: threeWayMerge(BASE, OURS, BASE),
    resolutions: {},
    schemaEnabled: false,
    schema: null,
    onSchemaEnabledChange: () => {},
    onSchemaChange: () => {},
    refCheckEnabled: false,
    refCheckConfig: '',
    onRefCheckEnabledChange: () => {},
    onRefCheckConfigChange: () => {},
    onBack: () => {},
    onRestart: () => {},
  };
}

/** 模拟 App 持有有效规则配置：onProtectedConfigChange 更新闭包并用同一 key 重渲染 */
function setup(key = 'main') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let config = '';
  const render = makeRenderer(container);
  const rerender = (k = key) =>
    render(
      <OutputStage
        key={k}
        {...stageProps()}
        protectedConfig={config}
        onProtectedConfigChange={(t) => {
          config = t;
          rerender(k);
        }}
      />,
    );
  rerender();
  return {
    container,
    rerender,
    getConfig: () => config,
    setConfig: (c: string) => {
      config = c;
      rerender();
    },
  };
}

const mergedDownloadBtn = (container: HTMLElement) => btnByText(container, '下载 merged.json')!;
const patchDownloadBtn = (container: HTMLElement) => btnByText(container, '下载 patch.json')!;

describe('受保护路径检查（OutputStage 集成）', () => {
  it('配置规则后按变更路径合并展示命中项（规则 / 路径 / 类型 / 来源），逐项确认前禁用下载', () => {
    const { container } = setup();

    // 未配置规则：不限制下载
    expect(h(container, '.protected-summary.none')?.textContent).toContain('未配置保护规则');
    expect(mergedDownloadBtn(container).disabled).toBe(false);
    expect(patchDownloadBtn(container).disabled).toBe(false);

    // 逐行配置两条规则并应用
    act(() => typeInto(container, '.protected-input', '/svc/**\n/extra'));
    act(() => btnByText(container, '应用规则')!.click());

    // 命中两项：/svc/pwd（修改，命中第 1 行规则）与 /extra（新增，命中第 2 行规则）
    const rows = all(container, '.protected-hit-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('修改');
    expect(rows[0].textContent).toContain('/svc/pwd');
    expect(rows[0].textContent).toContain('仅当前分支');
    expect(rows[0].querySelector('.protected-rule-chip')?.textContent).toContain('#1 /svc/**');
    expect(rows[1].textContent).toContain('新增');
    expect(rows[1].textContent).toContain('/extra');
    expect(rows[1].querySelector('.protected-rule-chip')?.textContent).toContain('#2 /extra');

    // 未全部确认：两个下载按钮均禁用并给出警示
    expect(mergedDownloadBtn(container).disabled).toBe(true);
    expect(patchDownloadBtn(container).disabled).toBe(true);
    expect(h(container, '.protected-summary.pending')?.textContent).toContain('已确认 0 / 2');
    expect(all(container, '.download-warn').some((w) => w.textContent?.includes('受保护命中未确认'))).toBe(true);

    // 逐项确认：确认第一项后仍禁用
    act(() => (rows[0].querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    expect(h(container, '.protected-summary.pending')?.textContent).toContain('已确认 1 / 2');
    expect(mergedDownloadBtn(container).disabled).toBe(true);

    // 全部确认后恢复下载
    act(() => (all(container, '.protected-hit-row')[1].querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    expect(h(container, '.protected-summary.ok')?.textContent).toContain('已全部确认');
    expect(mergedDownloadBtn(container).disabled).toBe(false);
    expect(patchDownloadBtn(container).disabled).toBe(false);

    // 取消其中一项确认 → 再次禁用
    act(() => (all(container, '.protected-hit-row')[0].querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    expect(mergedDownloadBtn(container).disabled).toBe(true);
  });

  it('配置非法时就地提示且不更新有效规则（命中清单与确认状态沿用旧规则）', () => {
    const { container, getConfig } = setup();

    // 先应用一份合法规则
    act(() => typeInto(container, '.protected-input', '/svc/**'));
    act(() => btnByText(container, '应用规则')!.click());
    expect(all(container, '.protected-hit-row')).toHaveLength(1);
    expect(getConfig()).toBe('/svc/**');

    // 改为非法配置并应用：就地报错，有效规则不变
    act(() => typeInto(container, '.protected-input', 'not-a-pointer'));
    act(() => btnByText(container, '应用规则')!.click());
    expect(h(container, '.error-text')?.textContent).toContain('第 1 行');
    expect(h(container, '.error-text')?.textContent).toContain('必须以 / 开头');
    expect(h(container, '.protected-status.bad')?.textContent).toContain('沿用上一份有效规则');
    expect(getConfig()).toBe('/svc/**');
    // 命中清单仍按旧规则计算
    expect(all(container, '.protected-hit-row')).toHaveLength(1);

    // 旧规则下的确认照常生效：确认后下载恢复
    act(() => (h(container, '.protected-hit-row input[type="checkbox"]') as HTMLInputElement).click());
    expect(mergedDownloadBtn(container).disabled).toBe(false);
  });

  it('返回调整并重新生成结果（组件重挂载）后清空确认，规则配置保留', () => {
    const { container, setConfig } = setup();
    setConfig('/svc/**');

    // 确认命中项 → 下载可用
    act(() => (h(container, '.protected-hit-row input[type="checkbox"]') as HTMLInputElement).click());
    expect(mergedDownloadBtn(container).disabled).toBe(false);

    // 模拟「返回调整 → 重新生成结果」：OutputStage 以新 key 重挂载，规则配置仍在
    const { container: remounted } = (() => {
      const c = document.createElement('div');
      document.body.appendChild(c);
      const render = makeRenderer(c);
      act(() => {
        render(
          <OutputStage
            key="regenerated"
            {...stageProps()}
            protectedConfig="/svc/**"
            onProtectedConfigChange={() => {}}
          />,
        );
      });
      return { container: c };
    })();

    // 命中清单按规则重新计算，但确认状态已清空 → 下载再次禁用
    expect(all(remounted, '.protected-hit-row')).toHaveLength(1);
    expect(
      (h(remounted, '.protected-hit-row input[type="checkbox"]') as HTMLInputElement).checked,
    ).toBe(false);
    expect(btnByText(remounted, '下载 merged.json')!.disabled).toBe(true);
    expect(btnByText(remounted, '下载 patch.json')!.disabled).toBe(true);
    expect(h(remounted, '.protected-summary.pending')?.textContent).toContain('已确认 0 / 1');
  });

  it('规则未命中任何变更时下载不受限；清空规则后同样不限制', () => {
    const { container, setConfig } = setup();
    setConfig('/nope/**');
    expect(h(container, '.protected-summary.ok')?.textContent).toContain('未命中');
    expect(mergedDownloadBtn(container).disabled).toBe(false);

    // 清空规则
    act(() => btnByText(container, '清空')!.click());
    expect(h(container, '.protected-summary.none')).not.toBeNull();
    expect(mergedDownloadBtn(container).disabled).toBe(false);
  });
});
