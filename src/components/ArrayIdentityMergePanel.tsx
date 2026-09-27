import { useMemo } from 'react';
import {
  alignByIdentity,
  buildIdentityArray,
  countPending,
  formatIdentity,
  isRecordLevelConflict,
  type AlignedRecord,
  type IdentityAlignment,
  type RecordConflict,
} from '../merge/arrayIdentity';
import type { Conflict, Resolution } from '../merge/threeWayMerge';
import { isAbsent, type JsonValue, type SideValue } from '../merge/types';

/** 「按身份字段合并」模块的本地工作状态（按冲突 id 保存在 ConflictPanel 中） */
export interface IdentityMergeState {
  /** 用户填写的顶层身份字段名 */
  field: string;
  /** 字段级裁决：RecordConflict.key → 采用当前 / 目标 */
  decisions: Record<string, Resolution>;
}

export const emptyIdentityMergeState: IdentityMergeState = { field: '', decisions: {} };

interface Props {
  conflict: Conflict;
  state: IdentityMergeState;
  onStateChange: (next: IdentityMergeState) => void;
  /** 提交候选数组为该冲突的自定义值（一次提交，接入撤销/重做） */
  onSubmit: (value: JsonValue) => void;
  /** 该冲突当前是否已有选择（用于提示覆盖关系） */
  currentResolution: Resolution | undefined;
}

function sideValueText(v: SideValue): string {
  if (isAbsent(v)) return '（此侧已删除）';
  return JSON.stringify(v);
}

/** 裁决按钮文案：区分「删除」与「置为 null」（删除与 null 有别） */
function choiceLabel(sideName: string, value: SideValue, noun: string): string {
  if (isAbsent(value)) return `采用${sideName}（删除${noun}）`;
  if (value === null) return `采用${sideName}（置为 null）`;
  return `采用${sideName}`;
}

function recordTitle(rec: AlignedRecord): string {
  const id = formatIdentity(rec.identity);
  if (rec.fromBase) return `记录 ${id}（基线第 ${rec.baseIndex + 1} 项）`;
  const from =
    rec.addedFrom === 'ours' ? '仅当前分支新增' : rec.addedFrom === 'theirs' ? '仅目标分支新增' : '双方新增';
  return `记录 ${id}（新身份 · ${from}）`;
}

function ConflictChoice({
  rc,
  decision,
  onDecide,
}: {
  rc: RecordConflict;
  decision: Resolution | undefined;
  onDecide: (key: string, res: Resolution) => void;
}) {
  const recordLevel = isRecordLevelConflict(rc);
  const noun = recordLevel ? '该项' : '该字段';
  const { base, ours, theirs, reason, pointer } = rc.conflict;
  const cls = (kind: Resolution['kind']) => (decision?.kind === kind ? ' active-choice' : '');
  return (
    <div className={`idm-conflict${decision ? ' decided' : ''}`}>
      <div className="idm-conflict-head">
        <code>{pointer}</code>
        <span className="idm-conflict-reason">
          {recordLevel ? `记录级冲突：${reason}` : `字段 ${rc.fieldPointer}：${reason}`}
        </span>
      </div>
      <div className="idm-conflict-values">
        <div>
          <h5>基线</h5>
          <pre>{sideValueText(base)}</pre>
        </div>
        <div>
          <h5>当前分支</h5>
          <pre>{sideValueText(ours)}</pre>
        </div>
        <div>
          <h5>目标分支</h5>
          <pre>{sideValueText(theirs)}</pre>
        </div>
      </div>
      <div className="resolve-actions">
        <button
          className={`ours-btn small${cls('ours')}`}
          onClick={() => onDecide(rc.key, { kind: 'ours' })}
        >
          {choiceLabel('当前分支', ours, noun)}
        </button>
        <button
          className={`theirs-btn small${cls('theirs')}`}
          onClick={() => onDecide(rc.key, { kind: 'theirs' })}
        >
          {choiceLabel('目标分支', theirs, noun)}
        </button>
        {decision && <span className="idm-decided-tag">✓ 已裁决</span>}
      </div>
    </div>
  );
}

function RecordBlock({
  rec,
  recordIndex,
  alignment,
  decisions,
  onDecide,
}: {
  rec: AlignedRecord;
  recordIndex: number;
  alignment: IdentityAlignment;
  decisions: Record<string, Resolution>;
  onDecide: (key: string, res: Resolution) => void;
}) {
  const conflicts = alignment.conflicts.filter((c) => c.recordIndex === recordIndex);
  const pending = conflicts.filter((c) => !decisions[c.key]).length;
  const merged = alignment.merges[recordIndex].root.merged;
  const autoDeleted = conflicts.length === 0 && isAbsent(merged);

  return (
    <div className={`idm-record${pending > 0 ? ' pending' : ''}`}>
      <div className="idm-record-head">
        <span className="idm-record-title">{recordTitle(rec)}</span>
        {conflicts.length === 0 && !autoDeleted && <span className="badge both">自动合并</span>}
        {autoDeleted && <span className="badge conflict">双方删除</span>}
        {pending > 0 && <span className="badge conflict">待裁决 {pending}</span>}
        {conflicts.length > 0 && pending === 0 && <span className="badge resolved">✓ 已裁决</span>}
      </div>
      {conflicts.length === 0 && !autoDeleted && (
        <pre className="idm-record-preview">{JSON.stringify(merged)}</pre>
      )}
      {autoDeleted && <div className="idm-record-note">双方均删除该项，结果中不保留。</div>}
      {conflicts.map((rc) => (
        <ConflictChoice key={rc.key} rc={rc} decision={decisions[rc.key]} onDecide={onDecide} />
      ))}
    </div>
  );
}

/**
 * 「按身份字段合并」模块：仅处理三方均为对象数组的冲突。
 * 按顶层身份字段对齐记录后复用对象三方合并规则，逐项裁决字段级冲突，
 * 全部完成后把候选数组一次提交为原数组冲突的自定义值。
 */
export default function ArrayIdentityMergePanel({
  conflict,
  state,
  onStateChange,
  onSubmit,
  currentResolution,
}: Props) {
  const { field, decisions } = state;

  const alignment = useMemo<IdentityAlignment | null>(() => {
    if (field === '') return null;
    return alignByIdentity(conflict.base, conflict.ours, conflict.theirs, field, conflict.segments);
  }, [conflict, field]);

  const violations = alignment?.violations ?? [];
  const valid = alignment !== null && violations.length === 0;
  const pending = alignment && valid ? countPending(alignment, decisions) : 0;
  const candidate = valid && pending === 0 ? buildIdentityArray(alignment, decisions) : undefined;

  const setField = (nextField: string) => {
    // 更换身份字段后对齐关系变化，清空已有裁决
    onStateChange({ field: nextField, decisions: {} });
  };

  const decide = (key: string, res: Resolution) => {
    onStateChange({ field, decisions: { ...decisions, [key]: res } });
  };

  const submitted = currentResolution?.kind === 'custom';

  return (
    <div className="idm-panel">
      <div className="idm-head">
        <h4>按身份字段合并</h4>
        <span className="hint">
          三方均为对象数组：填写每项的顶层身份字段名，按身份对齐记录后逐项裁决，一次提交为自定义值
        </span>
      </div>
      <div className="idm-field-row">
        <label htmlFor="idm-field-input">身份字段</label>
        <input
          id="idm-field-input"
          className="idm-field-input"
          type="text"
          placeholder='例如 "id"'
          value={field}
          onChange={(e) => setField(e.target.value)}
          spellCheck={false}
        />
        {submitted && <span className="idm-submitted-tag">✓ 已提交自定义值，可撤销或重新提交覆盖</span>}
      </div>

      {field === '' && <div className="idm-hint">填写身份字段名后，将按身份对齐三方记录。</div>}

      {alignment && violations.length > 0 && (
        <div className="idm-violations">
          <div className="idm-violations-title">
            ⚠ 身份校验未通过（{violations.length} 处），禁止提交：
          </div>
          <ul>
            {violations.map((v, i) => (
              <li key={i}>
                <strong>{v.side}</strong> · {v.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {alignment && valid && (
        <>
          <div className="idm-summary">
            对齐 <strong>{alignment.records.length}</strong> 条记录，字段级冲突{' '}
            <strong>{alignment.conflicts.length}</strong> 处，待裁决 <strong>{pending}</strong> 处
          </div>
          <div className="idm-records">
            {alignment.records.map((rec, i) => (
              <RecordBlock
                key={formatIdentity(rec.identity)}
                rec={rec}
                recordIndex={i}
                alignment={alignment}
                decisions={decisions}
                onDecide={decide}
              />
            ))}
          </div>
          {candidate !== undefined ? (
            <div className="idm-candidate">
              <h5>候选数组（提交为该冲突的自定义值）</h5>
              <pre>{JSON.stringify(candidate, null, 2)}</pre>
              <div className="idm-actions">
                <button className="primary" onClick={() => onSubmit(candidate)}>
                  {submitted ? '重新提交候选数组' : '提交候选数组'}
                </button>
                {currentResolution && !submitted && (
                  <span className="idm-cover-hint">提交将覆盖当前已选方案</span>
                )}
              </div>
            </div>
          ) : (
            <div className="idm-pending-tip">完成全部 {pending} 处裁决后生成候选数组并允许提交。</div>
          )}
        </>
      )}
    </div>
  );
}
