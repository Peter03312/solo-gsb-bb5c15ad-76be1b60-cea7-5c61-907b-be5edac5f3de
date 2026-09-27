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

const h = (container: ParentNode, sel: string) => container.querySelector(sel);
const all = (container: ParentNode, sel: string) => [...container.querySelectorAll(sel)];
const btnByText = (container: ParentNode, text: string) =>
  all(container, 'button').find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

/** React 受控组件需要用原生 setter 赋值后再派发 input 事件 */
function typeInto(container: ParentNode, sel: string, v: string) {
  const ta = h(container, sel) as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(ta, v);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

const BASE: JsonValue = { keep: 1 };
const MERGED: JsonValue = {
  keep: 1,
  servers: [
    { id: 's1', role: 'web' },
    { id: 's2', role: 'job' },
  ],
  apps: [
    { name: 'web', serverId: 's1' },
    { name: 'job', serverId: 's9' },
  ],
};

function stageProps() {
  return {
    base: BASE,
    merged: MERGED,
    patch: diff(BASE, MERGED),
    mergeResult: threeWayMerge(BASE, MERGED, BASE),
    resolutions: {},
    schemaEnabled: false,
    schema: null,
    onSchemaEnabledChange: () => {},
    onSchemaChange: () => {},
    protectedConfig: '',
    onProtectedConfigChange: () => {},
    onBack: () => {},
    onRestart: () => {},
  };
}

const VALID_CONFIG = JSON.stringify([
  { target: '/servers', identity: 'id', ref: '/apps/*/serverId' },
]);

/** 模拟 App 持有开关与规则配置：回调更新闭包并重渲染 */
function setup(key = 'main') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let enabled = false;
  let config = '';
  const render = makeRenderer(container);
  const rerender = (k = key) =>
    render(
      <OutputStage
        key={k}
        {...stageProps()}
        refCheckEnabled={enabled}
        refCheckConfig={config}
        onRefCheckEnabledChange={(v) => {
          enabled = v;
          rerender(k);
        }}
        onRefCheckConfigChange={(t) => {
          config = t;
          rerender(k);
        }}
      />,
    );
  rerender();
  return {
    container,
    rerender,
    getEnabled: () => enabled,
    getConfig: () => config,
    setState: (e: boolean, c: string) => {
      enabled = e;
      config = c;
      rerender();
    },
  };
}

const mergedDownloadBtn = (container: HTMLElement) => btnByText(container, '下载 merged.json')!;
const patchDownloadBtn = (container: HTMLElement) => btnByText(container, '下载 patch.json')!;
const panel = (container: HTMLElement) => h(container, '.refcheck-panel')!;

describe('引用完整性检查（OutputStage 集成）', () => {
  it('默认关闭：无规则编辑区，下载不受限；开启后未配置规则同样不受限', () => {
    const { container } = setup();
    expect(h(container, '.refcheck-input')).toBeNull();
    expect(mergedDownloadBtn(container).disabled).toBe(false);

    act(() => (h(container, '.refcheck-toggle input') as HTMLInputElement).click());
    expect(h(container, '.refcheck-input')).not.toBeNull();
    expect(h(container, '.refcheck-summary.none')?.textContent).toContain('未配置引用规则');
    expect(mergedDownloadBtn(container).disabled).toBe(false);
  });

  it('悬空引用按规则序号与具体路径列出，启用且有错误时禁止下载两个导出文件', () => {
    const { container } = setup();
    act(() => (h(container, '.refcheck-toggle input') as HTMLInputElement).click());
    act(() => typeInto(container, '.refcheck-input', VALID_CONFIG));
    act(() => btnByText(panel(container) as HTMLElement, '应用规则')!.click());

    // 悬空引用：规则 #1，/apps/1/serverId → "s9"
    expect(h(container, '.refcheck-summary.bad')?.textContent).toContain('1 个悬空引用');
    const row = h(container, '.refcheck-issue-row')!;
    expect(row.querySelector('.refcheck-rule-chip')?.textContent).toContain('规则 #1');
    expect(row.querySelector('.issue-pointer')?.textContent).toBe('/apps/1/serverId');
    expect(row.textContent).toContain('"s9"');

    // 两个下载按钮均禁用并给出警示
    expect(mergedDownloadBtn(container).disabled).toBe(true);
    expect(patchDownloadBtn(container).disabled).toBe(true);
    expect(
      all(container, '.download-warn').some((w) => w.textContent?.includes('引用完整性检查未通过')),
    ).toBe(true);

    // 点击路径在合并结果视图中定位高亮
    act(() => {
      row.querySelector('.issue-pointer')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(h(container, '.json-line.hit')?.textContent).toContain('"serverId": "s9"');

    // 修改规则（只检查 /apps/0）后重新检查：通过并恢复下载
    act(() =>
      typeInto(
        container,
        '.refcheck-input',
        JSON.stringify([{ target: '/servers', identity: 'id', ref: '/apps/0/serverId' }]),
      ),
    );
    act(() => btnByText(panel(container) as HTMLElement, '应用规则')!.click());
    expect(h(container, '.refcheck-summary.ok')?.textContent).toContain('全部命中目标索引');
    expect(mergedDownloadBtn(container).disabled).toBe(false);
    expect(patchDownloadBtn(container).disabled).toBe(false);
  });

  it('规则错误（目标缺失 / 身份重复等）同样列出并禁止下载', () => {
    const { container } = setup();
    act(() => (h(container, '.refcheck-toggle input') as HTMLInputElement).click());
    act(() =>
      typeInto(
        container,
        '.refcheck-input',
        JSON.stringify([
          { target: '/nope', identity: 'id', ref: '/apps/*/serverId' },
          { target: '/servers', identity: 'missing', ref: '/apps/*/serverId' },
        ]),
      ),
    );
    act(() => btnByText(panel(container) as HTMLElement, '应用规则')!.click());

    expect(h(container, '.refcheck-summary.bad')?.textContent).toContain('规则错误');
    const rows = all(container, '.refcheck-issue-row');
    // 规则 1：目标缺失；规则 2：两项身份缺失（引用不再求值，无悬空）
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('规则 #1');
    expect(rows[0].textContent).toContain('/nope');
    expect(rows[0].textContent).toContain('目标对象数组缺失');
    expect(rows[1].textContent).toContain('规则 #2');
    expect(rows[1].textContent).toContain('/servers/0');
    expect(rows[1].textContent).toContain('缺少身份字段');
    expect(mergedDownloadBtn(container).disabled).toBe(true);
  });

  it('配置非法时就地提示且不更新有效规则（检查沿用旧规则）', () => {
    const { container, getConfig } = setup();
    act(() => (h(container, '.refcheck-toggle input') as HTMLInputElement).click());
    act(() => typeInto(container, '.refcheck-input', VALID_CONFIG));
    act(() => btnByText(panel(container) as HTMLElement, '应用规则')!.click());
    expect(getConfig()).toBe(VALID_CONFIG);
    expect(all(container, '.refcheck-issue-row')).toHaveLength(1);

    // 改为非法 JSON：就地报错，有效规则不变
    act(() => typeInto(container, '.refcheck-input', '[{bad'));
    act(() => btnByText(panel(container) as HTMLElement, '应用规则')!.click());
    expect(h(container, '.error-text')?.textContent).toContain('JSON 解析失败');
    expect(
      all(container, '.refcheck-status.bad').some((s) =>
        s.textContent?.includes('沿用上一份有效规则'),
      ),
    ).toBe(true);
    expect(getConfig()).toBe(VALID_CONFIG);
    expect(all(container, '.refcheck-issue-row')).toHaveLength(1);

    // 改为缺字段的规则：带规则序号报错
    act(() => typeInto(container, '.refcheck-input', '[{"target":"/servers"}]'));
    act(() => btnByText(panel(container) as HTMLElement, '应用规则')!.click());
    expect(h(container, '.error-text')?.textContent).toContain('规则 #1');
    expect(h(container, '.error-text')?.textContent).toContain('identity');
    expect(getConfig()).toBe(VALID_CONFIG);
  });

  it('返回调整并重新生成结果（组件重挂载）后规则保留并重新检查；清空规则后不受限', () => {
    const { container, setState } = setup();
    setState(true, VALID_CONFIG);
    expect(all(container, '.refcheck-issue-row')).toHaveLength(1);
    expect(mergedDownloadBtn(container).disabled).toBe(true);

    // 模拟「返回调整 → 重新生成结果」：OutputStage 以新 key 重挂载，开关与规则仍在
    const remounted = document.createElement('div');
    document.body.appendChild(remounted);
    let remountConfig = VALID_CONFIG;
    const render = makeRenderer(remounted);
    const rerenderRemounted = () =>
      render(
        <OutputStage
          key="regenerated"
          {...stageProps()}
          refCheckEnabled
          refCheckConfig={remountConfig}
          onRefCheckEnabledChange={() => {}}
          onRefCheckConfigChange={(t) => {
            remountConfig = t;
            rerenderRemounted();
          }}
        />,
      );
    act(() => {
      rerenderRemounted();
    });
    // 检查按最新结果自动重算：悬空引用仍在、下载仍禁用，无需重新输入规则
    expect(all(remounted, '.refcheck-issue-row')).toHaveLength(1);
    expect(btnByText(remounted, '下载 merged.json')!.disabled).toBe(true);
    expect(
      (h(remounted, '.refcheck-input') as HTMLTextAreaElement).value,
    ).toBe(VALID_CONFIG);

    // 清空规则：检查移除，下载恢复
    act(() => btnByText(panel(remounted) as HTMLElement, '清空')!.click());
    expect(h(remounted, '.refcheck-summary.none')).not.toBeNull();
    expect(btnByText(remounted, '下载 merged.json')!.disabled).toBe(false);
  });

  it('关闭开关后即使有错误也不禁止下载', () => {
    const { container } = setup();
    act(() => (h(container, '.refcheck-toggle input') as HTMLInputElement).click());
    act(() => typeInto(container, '.refcheck-input', VALID_CONFIG));
    act(() => btnByText(panel(container) as HTMLElement, '应用规则')!.click());
    expect(mergedDownloadBtn(container).disabled).toBe(true);

    act(() => (h(container, '.refcheck-toggle input') as HTMLInputElement).click());
    expect(h(container, '.refcheck-input')).toBeNull();
    expect(mergedDownloadBtn(container).disabled).toBe(false);
    expect(patchDownloadBtn(container).disabled).toBe(false);
  });
});
