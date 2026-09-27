import { useReducer, useState } from 'react';
import InputStage from './components/InputStage';
import MergeStage from './components/MergeStage';
import OutputStage from './components/OutputStage';
import { diff, type PatchOp } from './merge/rfc6902';
import {
  buildMerged,
  threeWayMerge,
  type MergeResult,
  type Resolutions,
} from './merge/threeWayMerge';
import { isAbsent, type JsonValue } from './merge/types';
import type { CompiledSchema } from './merge/schema';
import {
  restoreResolutions,
  type RestoreSummary,
  type SessionSnapshot,
} from './merge/snapshot';
import {
  describeResolution,
  diffResolutions,
  initHistory,
  resolutionHistoryReducer,
  type HistoryTransaction,
  type TransactionKind,
} from './merge/history';

type Stage = 'input' | 'merge' | 'output';

export default function App() {
  const [stage, setStage] = useState<Stage>('input');
  const [baseDoc, setBaseDoc] = useState<JsonValue | null>(null);
  const [mergeResult, setMergeResult] = useState<MergeResult | null>(null);
  // 决策历史（撤销/重做）在「冲突处理 ↔ 输出」两阶段之间持续保留
  const [history, dispatchHistory] = useReducer(resolutionHistoryReducer, {}, initHistory);
  const resolutions = history.present;
  const [merged, setMerged] = useState<JsonValue | null>(null);
  const [patch, setPatch] = useState<PatchOp[]>([]);
  // 快照导入的恢复汇总（进入合并页时展示一次）
  const [restoreInfo, setRestoreInfo] = useState<RestoreSummary | null>(null);
  // Schema 校验状态在「返回调整 ↔ 输出」之间保留，重新开始时清空
  const [schemaEnabled, setSchemaEnabled] = useState(false);
  const [schema, setSchema] = useState<CompiledSchema | null>(null);
  // 受保护路径规则同样在「返回调整 ↔ 输出」之间保留（确认状态在输出页内，重新生成即清空）
  const [protectedConfig, setProtectedConfig] = useState('');
  // 引用完整性检查开关与规则配置也在「返回调整 ↔ 输出」之间保留，重新开始时清空
  const [refCheckEnabled, setRefCheckEnabled] = useState(false);
  const [refCheckConfig, setRefCheckConfig] = useState('');

  const handleMerge = (base: JsonValue, ours: JsonValue, theirs: JsonValue) => {
    setBaseDoc(base);
    setMergeResult(threeWayMerge(base, ours, theirs));
    dispatchHistory({ type: 'reset', present: {} });
    setMerged(null);
    setPatch([]);
    setRestoreInfo(null);
    setStage('merge');
  };

  // 导入会话快照：用快照中的三份源 JSON 重新执行三方合并，再按指针 + 三方值恢复选择。
  // 恢复结果作为不可撤销的初始状态（清空撤销/重做历史）。
  const handleImportSnapshot = (snapshot: SessionSnapshot) => {
    const result = threeWayMerge(snapshot.base, snapshot.ours, snapshot.theirs);
    const { resolutions: restored, ...summary } = restoreResolutions(snapshot, result);
    setBaseDoc(snapshot.base);
    setMergeResult(result);
    dispatchHistory({ type: 'reset', present: restored });
    setMerged(null);
    setPatch([]);
    setRestoreInfo(summary);
    setStage('merge');
  };

  // 手动决策（单个冲突）或一次批量规则应用（多个冲突）→ 各记为一个历史事务
  const commitResolutions = (kind: TransactionKind, next: Resolutions): HistoryTransaction | null => {
    const changes = diffResolutions(resolutions, next);
    if (changes.length === 0) return null;
    dispatchHistory({ type: 'commit', kind, next });
    // 以当前状态即时构造事务，供调用方定位首个受影响冲突（label 与 reducer 保持一致）
    return {
      kind,
      label:
        kind === 'batch'
          ? `批量应用规则（${changes.length} 项冲突）`
          : describeResolution(changes[0].after),
      changes,
    };
  };

  const undo = (): HistoryTransaction | null => {
    if (history.past.length === 0) return null;
    const transaction = history.past[history.past.length - 1];
    dispatchHistory({ type: 'undo' });
    return transaction;
  };

  const redo = (): HistoryTransaction | null => {
    if (history.future.length === 0) return null;
    const transaction = history.future[0];
    dispatchHistory({ type: 'redo' });
    return transaction;
  };

  const handleFinish = () => {
    if (!mergeResult || baseDoc === null) return;
    const result = buildMerged(mergeResult.root, resolutions);
    if (result === undefined || isAbsent(result)) return;
    setMerged(result);
    setPatch(diff(baseDoc, result));
    setStage('output');
  };

  const handleRestart = () => {
    setStage('input');
    setMergeResult(null);
    setBaseDoc(null);
    dispatchHistory({ type: 'reset', present: {} });
    setMerged(null);
    setPatch([]);
    setRestoreInfo(null);
    setSchema(null);
    setSchemaEnabled(false);
    setProtectedConfig('');
    setRefCheckEnabled(false);
    setRefCheckConfig('');
  };

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  return (
    <>
      <header className="app-header">
        <h1>JSON 三方合并台</h1>
        <div className="steps">
          <span className={`step ${stage === 'input' ? 'active' : 'done'}`}>1 输入</span>
          <span className={`step ${stage === 'merge' ? 'active' : stage === 'output' ? 'done' : ''}`}>
            2 解决冲突
          </span>
          <span className={`step ${stage === 'output' ? 'active' : ''}`}>3 导出结果</span>
        </div>
      </header>
      <main>
        {stage === 'input' && <InputStage onMerge={handleMerge} onImportSnapshot={handleImportSnapshot} />}
        {stage === 'merge' && mergeResult && (
          <MergeStage
            mergeResult={mergeResult}
            resolutions={resolutions}
            onCommit={commitResolutions}
            onUndo={undo}
            onRedo={redo}
            canUndo={canUndo}
            canRedo={canRedo}
            undoTransaction={canUndo ? history.past[history.past.length - 1] : null}
            redoTransaction={canRedo ? history.future[0] : null}
            onFinish={handleFinish}
            onBack={handleRestart}
            restoreInfo={restoreInfo}
          />
        )}
        {stage === 'output' && merged !== null && baseDoc !== null && mergeResult && (
          <OutputStage
            base={baseDoc}
            merged={merged}
            patch={patch}
            mergeResult={mergeResult}
            resolutions={resolutions}
            schemaEnabled={schemaEnabled}
            schema={schema}
            onSchemaEnabledChange={setSchemaEnabled}
            onSchemaChange={setSchema}
            protectedConfig={protectedConfig}
            onProtectedConfigChange={setProtectedConfig}
            refCheckEnabled={refCheckEnabled}
            refCheckConfig={refCheckConfig}
            onRefCheckEnabledChange={setRefCheckEnabled}
            onRefCheckConfigChange={setRefCheckConfig}
            onBack={() => setStage('merge')}
            onRestart={handleRestart}
          />
        )}
      </main>
    </>
  );
}
