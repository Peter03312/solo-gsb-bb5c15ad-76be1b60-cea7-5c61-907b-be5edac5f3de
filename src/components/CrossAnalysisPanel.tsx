import { useMemo, useState } from 'react';
import { isAbsent, type JsonValue } from '../merge/types';
import {
  analyzeCrossChanges,
  IMPACT_DESCRIPTION,
  IMPACT_LABEL,
  IMPACT_ORDER,
  SIDE_CHANGE_LABEL,
  type CrossImpactEntry,
  type ImpactType,
  type SideChange,
  type SideName,
} from '../merge/crossAnalysis';

interface Props {
  base: JsonValue;
  ours: JsonValue;
  theirs: JsonValue;
  /** 返回输入编辑（保留三份输入内容） */
  onBack: () => void;
  /** 以当前三份文档进入现有合并流程 */
  onMerge: () => void;
}

/** 单侧值展示：未改动 / 删除 / 新增修改值三态 */
function SideCell({ label, change }: { label: string; change: SideChange | null }) {
  if (!change) {
    return (
      <div className="cross-side">
        <h4>{label}</h4>
        <div className="cross-nochange">未改动</div>
      </div>
    );
  }
  const absent = isAbsent(change.value);
  return (
    <div className="cross-side">
      <h4>
        {label}
        <span className={`cross-kind ${change.kind}`}>{SIDE_CHANGE_LABEL[change.kind]}</span>
      </h4>
      <pre className={absent ? 'dim' : ''}>{absent ? '（不存在，已删除）' : JSON.stringify(change.value, null, 2)}</pre>
    </div>
  );
}

/** 影响矩阵行：两侧变更徽标 + 影响类型 */
function ChangeBadge({ side, change }: { side: SideName; change: SideChange | null }) {
  if (!change) return <span className="cross-badge none">·</span>;
  return (
    <span className={`cross-badge ${side} ${change.kind}`} title={`${side === 'ours' ? '当前分支' : '目标分支'}：${SIDE_CHANGE_LABEL[change.kind]}`}>
      {SIDE_CHANGE_LABEL[change.kind]}
    </span>
  );
}

function EntryDetail({ entry }: { entry: CrossImpactEntry }) {
  return (
    <div className="cross-detail">
      <div className="cross-detail-head">
        <span className="cross-detail-pointer">
          {entry.pointer === '' ? '（根节点）' : entry.pointer}
        </span>
        <span className={`cross-impact-tag ${entry.impact}`}>{IMPACT_LABEL[entry.impact]}</span>
        {entry.ancestor && (
          <span className="cross-ancestor-note">
            受{entry.ancestor.side === 'ours' ? '当前分支' : '目标分支'}在{' '}
            <code>{entry.ancestor.pointer === '' ? '（根节点）' : entry.ancestor.pointer}</code>{' '}
            的「{SIDE_CHANGE_LABEL[entry.ancestor.kind]}」整体变更影响
          </span>
        )}
      </div>
      <div className="cross-values">
        <div className="cross-side">
          <h4>基线 (Base)</h4>
          <pre className={isAbsent(entry.base) ? 'dim' : ''}>
            {isAbsent(entry.base) ? '（不存在）' : JSON.stringify(entry.base, null, 2)}
          </pre>
        </div>
        <SideCell label="当前分支 (Ours)" change={entry.ours} />
        <SideCell label="目标分支 (Theirs)" change={entry.theirs} />
      </div>
    </div>
  );
}

/** 输入阶段的「变更交叉分析」面板：两侧相对基线的结构化变更与 JSON Pointer 影响矩阵 */
export default function CrossAnalysisPanel({ base, ours, theirs, onBack, onMerge }: Props) {
  const analysis = useMemo(() => analyzeCrossChanges(base, ours, theirs), [base, ours, theirs]);
  const { entries, counts, conflictPointers } = analysis;

  const [active, setActive] = useState<ReadonlySet<ImpactType>>(() => new Set());
  const [conflictOnly, setConflictOnly] = useState(false);
  const [selectedPointer, setSelectedPointer] = useState<string | null>(null);

  const visible = entries.filter((e) => {
    if (active.size > 0 && !active.has(e.impact)) return false;
    if (conflictOnly && !(e.impact === 'same-path-conflict' || e.impact === 'cross-ancestor-conflict'))
      return false;
    return true;
  });
  const selected = entries.find((e) => e.pointer === selectedPointer) ?? null;

  const toggle = (key: ImpactType) => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="cross-panel">
      <div className="cross-header">
        <h3>变更交叉分析</h3>
        <span className="hint">
          基于 Base / Ours / Theirs 计算两侧相对基线的结构化变更，按 JSON Pointer 展示影响矩阵；
          对象内互不相干的改动可自动合并，数组按整体值处理
        </span>
      </div>

      <div className="cross-summary">
        共 <strong>{counts.total}</strong> 条变更路径：可自动合并 <strong>{counts.autoMergeable}</strong>{' '}
        条 · 需人工裁决的冲突节点 <strong>{counts.conflictRoots}</strong> 个
      </div>

      <div className="cross-filters">
        <button
          type="button"
          className={`small cross-chip${active.size === 0 && !conflictOnly ? ' active' : ''}`}
          onClick={() => {
            setActive(new Set());
            setConflictOnly(false);
          }}
        >
          全部（{counts.total}）
        </button>
        {IMPACT_ORDER.map((key) => (
          <button
            key={key}
            type="button"
            className={`small cross-chip ${key}${active.has(key) ? ' active' : ''}`}
            onClick={() => toggle(key)}
            disabled={counts.byImpact[key] === 0}
            title={IMPACT_DESCRIPTION[key]}
          >
            {IMPACT_LABEL[key]}（{counts.byImpact[key]}）
          </button>
        ))}
        <label className="cross-conflict-toggle">
          <input
            type="checkbox"
            checked={conflictOnly}
            onChange={(e) => setConflictOnly(e.target.checked)}
          />{' '}
          仅看冲突
        </label>
      </div>

      {conflictPointers.length > 0 && (
        <div className="cross-conflict-pointers">
          <span>冲突节点：</span>
          {conflictPointers.map((p) => (
            <button
              key={p}
              type="button"
              className="hit-pointer"
              onClick={() => setSelectedPointer(p)}
              title="点击定位三方值"
            >
              {p === '' ? '（根节点）' : p}
            </button>
          ))}
        </div>
      )}

      <div className="cross-matrix">
        {visible.length === 0 && <div className="cross-empty">没有符合筛选条件的变更路径</div>}
        {visible.map((e) => (
          <button
            type="button"
            key={e.pointer}
            className={`cross-row ${e.impact}${selected?.pointer === e.pointer ? ' selected' : ''}`}
            onClick={() => setSelectedPointer(e.pointer)}
            title="点击查看该路径的基线 / 当前 / 目标三方值"
          >
            <span className="cross-path">{e.pointer === '' ? '（根）' : e.pointer}</span>
            <span className="cross-sides">
              <ChangeBadge side="ours" change={e.ours} />
              <ChangeBadge side="theirs" change={e.theirs} />
            </span>
            <span className={`cross-impact ${e.impact}`}>
              {e.ancestor && <span className="cross-descendant-mark" title="受对侧祖先整体变更影响">↳ 后代</span>}
              {IMPACT_LABEL[e.impact]}
            </span>
          </button>
        ))}
      </div>

      {selected && <EntryDetail entry={selected} />}

      <div className="cross-actions">
        <button type="button" onClick={onBack}>
          ← 返回编辑输入
        </button>
        <div className="spacer" style={{ flex: 1 }} />
        <button type="button" className="primary" onClick={onMerge}>
          开始合并 →
        </button>
      </div>
    </div>
  );
}
