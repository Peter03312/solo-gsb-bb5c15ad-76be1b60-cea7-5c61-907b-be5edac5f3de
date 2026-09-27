import { useMemo, useState } from 'react';
import { isAbsent, type JsonValue, type SideValue } from '../merge/types';
import type { MergeResult, Resolutions } from '../merge/threeWayMerge';
import {
  buildDecisionTrace,
  buildTraceReport,
  countTraceEntries,
  SOURCE_LABEL,
  TRACE_FILTERS,
  type ChangeKind,
  type TraceEntry,
  type TraceSource,
} from '../merge/decisionTrace';
import { downloadText } from '../download';

interface Props {
  mergeResult: MergeResult;
  resolutions: Resolutions;
  merged: JsonValue;
}

const CHANGE_LABEL: Record<ChangeKind, string> = {
  add: '新增',
  remove: '删除',
  replace: '修改',
};

/** 缺失（删除 / 从未存在）值的展示 */
function TraceValue({ label, value }: { label: string; value: SideValue }) {
  const absent = isAbsent(value);
  return (
    <div className={`trace-value${absent ? ' dim' : ''}`}>
      <h4>
        {label}
        {absent && <span className="absent-tag">缺失</span>}
      </h4>
      <pre>{absent ? '（不存在）' : JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

/** 输出阶段的「决策溯源」面板：最终结果相对基线的变更清单与逐项三方溯源 */
export default function DecisionTracePanel({ mergeResult, resolutions, merged }: Props) {
  // 返回调整后 OutputStage 会以新 props 重新挂载，useMemo 即按最新决策重新生成
  const entries = useMemo(
    () => buildDecisionTrace(mergeResult, resolutions, merged),
    [mergeResult, resolutions, merged],
  );
  const counts = useMemo(() => countTraceEntries(entries), [entries]);
  const reportText = useMemo(
    () => JSON.stringify(buildTraceReport(entries), null, 2),
    [entries],
  );

  const [active, setActive] = useState<ReadonlySet<TraceSource>>(() => new Set());
  const [selectedPointer, setSelectedPointer] = useState<string | null>(null);

  const visible = active.size === 0 ? entries : entries.filter((e) => active.has(e.source));
  const selected = entries.find((e) => e.pointer === selectedPointer) ?? null;

  const toggle = (key: TraceSource) => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="trace-panel">
      <div className="trace-header">
        <h3>决策溯源</h3>
        <span className="hint">
          按最终结果相对基线的变更路径列出每项决策来源；点击路径查看基线 / 当前 / 目标 / 最终值，缺失值以「（不存在）」标注
        </span>
      </div>
      <div className="trace-summary">
        共 <strong>{counts.total}</strong> 项变更：新增 {counts.add} · 删除 {counts.remove} · 修改{' '}
        {counts.replace}
      </div>
      <div className="trace-filters">
        <button
          type="button"
          className={`small trace-filter-chip${active.size === 0 ? ' active' : ''}`}
          onClick={() => setActive(new Set())}
        >
          全部（{counts.total}）
        </button>
        {TRACE_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`small trace-filter-chip ${f.key}${active.has(f.key) ? ' active' : ''}`}
            onClick={() => toggle(f.key)}
            disabled={counts.bySource[f.key] === 0}
            title={f.label}
          >
            {f.label}（{counts.bySource[f.key]}）
          </button>
        ))}
      </div>
      <div className="trace-list">
        {visible.length === 0 && <div className="trace-empty">没有符合条件的变更条目</div>}
        {visible.map((e) => (
          <button
            type="button"
            key={e.pointer}
            className={`trace-row ${e.source}${selected?.pointer === e.pointer ? ' selected' : ''}`}
            onClick={() => setSelectedPointer(e.pointer)}
            title="点击查看基线、两侧与最终值"
          >
            <span className={`trace-change ${e.change}`}>{CHANGE_LABEL[e.change]}</span>
            <span className="trace-path">{e.pointer === '' ? '（根）' : e.pointer}</span>
            <span className={`trace-source ${e.source}`}>{SOURCE_LABEL[e.source]}</span>
          </button>
        ))}
      </div>
      {selected && <TraceDetail entry={selected} />}
      <div className="panel-actions">
        <button type="button" className="small" onClick={() => downloadText('decision-trace.json', reportText)}>
          下载决策溯源报告 decision-trace.json
        </button>
      </div>
    </div>
  );
}

/** 展开的单项溯源详情：基线 / 当前分支 / 目标分支 / 最终值四栏 */
function TraceDetail({ entry }: { entry: TraceEntry }) {
  return (
    <div className="trace-detail">
      <div className="trace-detail-head">
        <span className="trace-detail-pointer">{entry.pointer === '' ? '（根节点）' : entry.pointer}</span>
        <span className={`trace-source ${entry.source}`}>{SOURCE_LABEL[entry.source]}</span>
        <span className={`trace-change ${entry.change}`}>{CHANGE_LABEL[entry.change]}</span>
      </div>
      <div className="trace-values">
        <TraceValue label="基线" value={entry.base} />
        <TraceValue label="当前分支" value={entry.ours} />
        <TraceValue label="目标分支" value={entry.theirs} />
        <TraceValue label="最终值" value={entry.final} />
      </div>
    </div>
  );
}
