import { useState } from 'react';
import { SOURCE_LABEL, type ChangeKind } from '../merge/decisionTrace';
import { parseProtectedRules, type ProtectedHit } from '../merge/protectedPaths';

interface Props {
  /** 已生效的规则配置文本（逐行一条模式；由 App 保存，返回调整重新生成后仍保留） */
  configText: string;
  /** 应用合法配置时更新有效规则；非法配置不会触发本回调（就地提示，沿用旧规则） */
  onConfigChange: (text: string) => void;
  /** 以决策溯源最终变更为输入算出的命中清单（已按变更路径合并） */
  hits: ProtectedHit[];
  /** 已逐项确认的变更路径 */
  confirmed: ReadonlySet<string>;
  onToggleConfirm: (pointer: string) => void;
}

const CHANGE_LABEL: Record<ChangeKind, string> = {
  add: '新增',
  remove: '删除',
  replace: '修改',
};

/**
 * 输出阶段的「受保护路径检查」面板：逐行配置 RFC 6901 路径模式，
 * 命中决策溯源的变更时列出规则、变更路径、类型与来源，逐项确认后才可下载导出文件。
 */
export default function ProtectedPathsPanel({
  configText,
  onConfigChange,
  hits,
  confirmed,
  onToggleConfirm,
}: Props) {
  const [text, setText] = useState(configText);
  const [errors, setErrors] = useState<string[]>([]);

  const dirty = text !== configText;

  const apply = () => {
    const { errors: lineErrors } = parseProtectedRules(text);
    if (lineErrors.length > 0) {
      // 配置非法：就地提示，不更新有效规则（命中清单仍按上一份有效规则计算）
      setErrors(lineErrors.map((e) => `第 ${e.line} 行「${e.pattern}」：${e.message}`));
      return;
    }
    setErrors([]);
    onConfigChange(text);
  };

  const clear = () => {
    setText('');
    setErrors([]);
    onConfigChange('');
  };

  const hasRules = configText.trim() !== '';
  const confirmedCount = hits.filter((h) => confirmed.has(h.entry.pointer)).length;
  const allConfirmed = hits.length > 0 && confirmedCount === hits.length;

  return (
    <section className="protected-panel">
      <div className="protected-header">
        <h3>受保护路径检查</h3>
        <span className="hint">
          逐行配置 RFC 6901 路径模式（整段 * 匹配一段、** 匹配零至多段）；子路径变更会命中受保护的父路径，
          父路径整体替换 / 删除会命中其下任一后代规则；命中项需逐项确认后才能下载 merged.json / patch.json
        </span>
      </div>
      <textarea
        className={`protected-input${errors.length > 0 ? ' invalid' : ''}`}
        placeholder={'/services/*/password\n/legacy/**'}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      {errors.length > 0 && (
        <div className="error-text">
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}
      <div className="panel-actions">
        <button
          className="small primary"
          onClick={apply}
          disabled={!dirty && errors.length === 0}
          title={dirty ? '应用当前规则并重新检查' : '规则已是最新'}
        >
          应用规则
        </button>
        <button className="small" onClick={clear} disabled={text === '' && configText === ''}>
          清空
        </button>
        {errors.length > 0 && (
          <span className="protected-status bad">● 配置非法，沿用上一份有效规则</span>
        )}
        {errors.length === 0 && dirty && (
          <span className="protected-status dirty">● 规则已修改，应用后重新检查</span>
        )}
      </div>
      {!hasRules && <div className="protected-summary none">未配置保护规则，下载不受限制</div>}
      {hasRules && hits.length === 0 && (
        <div className="protected-summary ok">✅ 当前变更未命中任何保护规则</div>
      )}
      {hasRules && hits.length > 0 && (
        <div className="protected-hits">
          <div className={`protected-summary${allConfirmed ? ' ok' : ' pending'}`}>
            {allConfirmed
              ? `✅ 命中 ${hits.length} 项变更，已全部确认，可以下载`
              : `⚠ 命中 ${hits.length} 项变更，已确认 ${confirmedCount} / ${hits.length}；全部确认后才能下载 merged.json / patch.json`}
          </div>
          <div className="protected-hit-list">
            {hits.map((hit) => {
              const pointer = hit.entry.pointer;
              const isConfirmed = confirmed.has(pointer);
              return (
                <label
                  key={pointer}
                  className={`protected-hit-row${isConfirmed ? ' confirmed' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={isConfirmed}
                    onChange={() => onToggleConfirm(pointer)}
                  />
                  <span className={`trace-change ${hit.entry.change}`}>
                    {CHANGE_LABEL[hit.entry.change]}
                  </span>
                  <span className="trace-path">{pointer === '' ? '（根）' : pointer}</span>
                  <span className={`trace-source ${hit.entry.source}`}>
                    {SOURCE_LABEL[hit.entry.source]}
                  </span>
                  <span className="protected-hit-rules">
                    {hit.rules.map((r) => (
                      <span key={r.line} className="protected-rule-chip" title={`第 ${r.line} 行`}>
                        #{r.line} {r.pattern}
                      </span>
                    ))}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
