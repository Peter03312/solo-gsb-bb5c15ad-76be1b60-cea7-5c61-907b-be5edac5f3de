import { useEffect, useRef, useState } from 'react';
import { isAbsent, type SideValue } from '../merge/types';
import type { MergeNode, Resolutions } from '../merge/threeWayMerge';

interface TreeProps {
  root: MergeNode;
  resolutions: Resolutions;
  selectedConflictId: string | null;
  onSelectConflict: (id: string) => void;
  showUnchanged: boolean;
}

function preview(v: SideValue): string {
  if (isAbsent(v)) return '∅（已删除）';
  const s = JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

function subtreeStats(node: MergeNode, resolutions: Resolutions): { total: number; resolved: number } {
  if (node.status === 'conflict') {
    return { total: 1, resolved: node.conflictId && resolutions[node.conflictId] ? 1 : 0 };
  }
  let total = 0;
  let resolved = 0;
  for (const c of node.children) {
    const s = subtreeStats(c, resolutions);
    total += s.total;
    resolved += s.resolved;
  }
  return { total, resolved };
}

function hasChanges(node: MergeNode): boolean {
  return node.status !== 'unchanged' || node.children.some(hasChanges);
}

const STATUS_BADGE: Partial<Record<MergeNode['status'], { cls: string; label: string }>> = {
  ours: { cls: 'ours', label: '采用当前' },
  theirs: { cls: 'theirs', label: '采用目标' },
  both: { cls: 'both', label: '双方一致' },
};

function resolutionLabel(res: Resolutions[string] | undefined): string {
  if (!res) return '';
  if (res.kind === 'ours') return '当前';
  if (res.kind === 'theirs') return '目标';
  return '自定义';
}

interface NodeProps {
  node: MergeNode;
  depth: number;
  resolutions: Resolutions;
  selectedConflictId: string | null;
  onSelectConflict: (id: string) => void;
  showUnchanged: boolean;
}

function TreeNode({ node, depth, resolutions, selectedConflictId, onSelectConflict, showUnchanged }: NodeProps) {
  const [open, setOpen] = useState(true);
  const rowRef = useRef<HTMLDivElement>(null);
  const isSelected = node.conflictId !== undefined && node.conflictId === selectedConflictId;

  useEffect(() => {
    if (isSelected) rowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [isSelected]);

  if (!showUnchanged && !hasChanges(node)) return null;

  const isConflict = node.status === 'conflict';
  const stats = node.status === 'object' ? subtreeStats(node, resolutions) : null;
  const unresolved = stats ? stats.total - stats.resolved : 0;
  const badge = STATUS_BADGE[node.status];
  const resolution = node.conflictId ? resolutions[node.conflictId] : undefined;
  const showValue = node.status !== 'object';

  const visibleChildren = showUnchanged ? node.children : node.children.filter(hasChanges);

  return (
    <>
      <div
        ref={rowRef}
        className={`tree-row${isConflict ? ' conflict' : ''}${isSelected ? ' selected' : ''}`}
        style={{ paddingLeft: depth * 20 + 6 }}
        onClick={isConflict && node.conflictId ? () => onSelectConflict(node.conflictId!) : undefined}
        title={node.pointer || '/'}
      >
        <span
          className="toggle"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
        >
          {node.children.length > 0 ? (open ? '▾' : '▸') : ''}
        </span>
        <span className="key">{node.key === '' ? '（根）' : node.key}</span>
        {badge && <span className={`badge ${badge.cls}`}>{badge.label}</span>}
        {isConflict && !resolution && <span className="badge conflict">冲突</span>}
        {isConflict && resolution && (
          <span className="badge resolved">✓ 已解决（{resolutionLabel(resolution)}）</span>
        )}
        {unresolved > 0 && <span className="badge conflict">{unresolved} 个冲突</span>}
        {showValue && (
          <span className="preview">
            {isConflict
              ? `当前: ${preview(node.ours)} ｜ 目标: ${preview(node.theirs)}`
              : `= ${preview(node.merged)}`}
          </span>
        )}
      </div>
      {open &&
        visibleChildren.map((child) => (
          <TreeNode
            key={child.key}
            node={child}
            depth={depth + 1}
            resolutions={resolutions}
            selectedConflictId={selectedConflictId}
            onSelectConflict={onSelectConflict}
            showUnchanged={showUnchanged}
          />
        ))}
    </>
  );
}

export default function MergeTree({ root, ...rest }: TreeProps) {
  return (
    <div className="tree">
      <TreeNode node={root} depth={0} {...rest} />
    </div>
  );
}
