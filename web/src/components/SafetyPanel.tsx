import { useMemo } from 'react';
import type { SafetyIssue, SafetyScanResult } from '../types';

interface Props {
  scan: SafetyScanResult;
  /** 定位到对应 cue 卡片（滚动 + 闪烁） */
  onLocate: (cueIndex: number) => void;
}

const KIND_LABEL: Record<SafetyIssue['kind'], string> = {
  kept: '人工保留',
  artifact: '替换产物',
  'cross-boundary': '跨边界新命中',
};

/**
 * 导出残留防线：按 cue 分组展示二次扫描发现的问题清单。
 * 人工保留仅提示；替换产物 / 跨边界新命中阻断导出。
 * 清单随预览实时重算（规则 / 例外 / 实体决定变化即刷新）。
 */
export function SafetyPanel({ scan, onLocate }: Props) {
  const byCue = useMemo(() => {
    const m = new Map<number, SafetyIssue[]>();
    for (const issue of scan.issues) {
      const arr = m.get(issue.cueIndex);
      if (arr) arr.push(issue);
      else m.set(issue.cueIndex, [issue]);
    }
    return Array.from(m.entries());
  }, [scan]);

  if (scan.issues.length === 0) return null;

  return (
    <section
      id="safety-panel"
      className={`safety-panel ${scan.blocked ? 'safety-blocked' : ''}`}
    >
      <header className="safety-header">
        <h3>导出残留防线</h3>
        <div className="safety-counts">
          <span className="safety-count safety-count-kept">
            人工保留 {scan.counts.kept} · 仅提示
          </span>
          <span className="safety-count safety-count-block">
            替换产物 {scan.counts.artifact} · 阻断
          </span>
          <span className="safety-count safety-count-block">
            跨边界 {scan.counts.crossBoundary} · 阻断
          </span>
        </div>
      </header>

      {scan.blocked ? (
        <p className="safety-banner">
          ⛔ 导出已被拦截：替换结果引入了新的规则命中。请调整替换模板 / 规则，
          或撤销相关命中（转为人工保留）后重试。
        </p>
      ) : (
        <p className="safety-banner safety-banner-warn">
          ⚠ 以下命中完全落在人工保留的原文上，仅提示，不阻断导出。
        </p>
      )}

      {byCue.map(([cueIndex, issues]) => (
        <div key={cueIndex} className="safety-cue">
          <div className="safety-cue-head">
            <span className="mono">
              第 {cueIndex + 1} 条 · {issues[0].time.start} → {issues[0].time.end}
            </span>
            <button className="btn btn-mini" onClick={() => onLocate(cueIndex)}>
              定位
            </button>
          </div>
          <ul className="safety-issue-list">
            {issues.map((issue) => (
              <li key={issue.key} className={`safety-issue safety-${issue.kind}`}>
                <span className={`safety-kind safety-kind-${issue.kind}`}>
                  {KIND_LABEL[issue.kind]}
                  {issue.blocking ? ' · 阻断' : ' · 仅提示'}
                </span>
                <span className="safety-match mono" title={issue.match}>
                  「{issue.match}」
                </span>
                {issue.kind === 'kept' && (
                  <span className="safety-desc">
                    目标规则「{issue.rule.name}」命中人工保留的原文（导出文本 [{issue.start},{' '}
                    {issue.end})）
                  </span>
                )}
                {issue.kind === 'artifact' && (
                  <span className="safety-desc">
                    来源规则「{issue.sourceRule?.name}」的替换产物被目标规则「{issue.rule.name}
                    」再次命中（导出文本 [{issue.start}, {issue.end})）
                  </span>
                )}
                {issue.kind === 'cross-boundary' && (
                  <span className="safety-desc">
                    目标规则「{issue.rule.name}」的命中横跨 {issue.segments?.length ?? 0}{' '}
                    个片段：
                    <span className="safety-segments">
                      {issue.segments?.map((s, i) => (
                        <span
                          key={i}
                          className={`safety-seg safety-seg-${s.origin}`}
                          title={s.text}
                        >
                          [{s.start}, {s.end}){' '}
                          {s.origin === 'original' ? '原文' : `替换产物·${s.ruleName}`}「{s.text}
                          」
                        </span>
                      ))}
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
