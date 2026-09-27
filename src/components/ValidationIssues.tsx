import type { IssueGroup } from '../merge/schema';
import { countIssues } from '../merge/schema';

interface Props {
  groups: IssueGroup[];
  onLocate: (instancePath: string) => void;
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`;
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 校验错误列表：按 instancePath 分组，点击 JSON Pointer 定位结果视图中的对应值 */
export default function ValidationIssues({ groups, onLocate }: Props) {
  const total = countIssues(groups);
  if (total === 0) {
    return <div className="validation-summary ok">✓ 合并结果符合 Schema 约束</div>;
  }
  return (
    <div className="validation-box bad">
      <div className="validation-summary">
        ⚠ 合并结果存在 <strong>{total}</strong> 个 Schema 校验错误（{groups.length} 个位置）；
        点击路径可在左侧结果中定位，仍可下载结果。
      </div>
      <div className="issue-list">
        {groups.map((g) => (
          <div className="issue-group" key={g.instancePath || '/'}>
            <button
              className="issue-pointer"
              title="在合并结果中定位"
              onClick={() => onLocate(g.instancePath)}
            >
              {g.instancePath || '/（根）'} ⤳
            </button>
            <ul>
              {g.issues.map((iss, i) => (
                <li key={i}>
                  <span className="keyword" title={`schemaPath: ${iss.schemaPath}`}>
                    {iss.keyword}
                  </span>
                  <span className="message">{iss.message}</span>
                  {Object.keys(iss.params).length > 0 && (
                    <span className="params">{formatValue(iss.params)}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
