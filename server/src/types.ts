/** 替换模式：固定模板 / 稳定化名 */
export type RuleMode = 'template' | 'alias';

/** 脱敏规则 */
export interface MaskRule {
  id: string;
  name: string;
  /** JS 正则表达式源码（不含首尾 /） */
  pattern: string;
  /** 正则标志，如 g / i；u 默认补齐 */
  flags: string;
  /**
   * 替换模板（mode = 'template' 时生效），支持：
   *  $& 整体命中、$1..$n 捕获组、$name 命名组、
   *  $RULE、$KEEP:n、$MASK:n、$MASKALL
   */
  replacement: string;
  /** 数值越大优先级越高；同值按规则名排序 */
  priority: number;
  enabled: boolean;
  /** 替换模式：template 固定模板；alias 稳定化名（编号持久、跨 cue 一致） */
  mode: RuleMode;
  /** 化名模式前缀，如「人物」→ 人物1 / 人物2；为空时使用「化名」 */
  aliasPrefix: string;
}

/**
 * 稳定化名映射条目。
 * 实体键 = 规则 id + 经 Unicode NFKC 归一化并去首尾空白后的原文；
 * 序号在规则内只增不复用，增删其他字幕 / 命中不会重排已有编号。
 */
export interface AliasEntry {
  ruleId: string;
  /** 实体键：NFKC + trim 后的规范原文 */
  entityKey: string;
  /** 规则内稳定编号（1 起） */
  seq: number;
  /** 最终化名（手动改名后为自定义值） */
  alias: string;
  /** true = 前缀+序号自动生成（跟随前缀变化）；false = 用户手动改名 */
  auto: boolean;
  /** 最近一次命中的原始文本（展示辅助，可空） */
  sourceText?: string;
}

/** 命中最终状态的决策来源：默认应用 / 继承实体决定 / 逐条显式例外 */
export type DecisionSource = 'default' | 'entity' | 'exception';

/** 实体级决定动作：apply 始终应用替换；keep 始终保留原文 */
export type EntityDecisionAction = 'apply' | 'keep';

/**
 * 实体级决定：按「规则 id + NFKC 归一实体键」持久化。
 * 同实体的新命中自动继承该决定；逐条例外优先于它；
 * 仅作用于优先级合并后的胜出命中，被抑制命中不受影响。
 */
export interface EntityDecision {
  ruleId: string;
  /** 实体键：NFKC + trim 后的规范原文 */
  entityKey: string;
  action: EntityDecisionAction;
  /** 决定时间（ISO 字符串，展示 / 审计辅助） */
  decidedAt: string;
}

/**
 * 逐条命中例外：审校员对单个命中的显式应用 / 撤销，
 * 优先于实体决定；清除例外后该命中恢复继承实体决定（或默认应用）。
 */
export interface HitException {
  /** 命中 key：cue 序号 + 时间 + 原文区间 + 规则 id */
  key: string;
  state: 'applied' | 'reverted';
}

/** 合并后落到某条字幕上的命中 */
export interface Hit {
  /** 稳定标识：cue 序号 + 原文区间 + 规则 id，例外状态据此恢复 */
  key: string;
  ruleId: string;
  ruleName: string;
  priority: number;
  /** 在 cue 纯文本中的起止偏移（含） */
  start: number;
  end: number;
  /** 原文区间 */
  match: string;
  replacement: string;
  /** true 表示最终状态为保留原文（撤销 / 实体保留决定） */
  reverted: boolean;
  /** 最终状态的决策来源：默认 / 实体决定 / 逐条例外 */
  decisionSource: DecisionSource;
  /** 实体键：NFKC + trim 后的原文（实体决策与稳定化名共用） */
  entityKey: string;
  /** 化名模式：最终化名 */
  alias?: string;
}

/** 被更高优先级 / 更长命中吞并的重叠命中，仅用于审计 */
export interface SuppressedHit {
  ruleId: string;
  ruleName: string;
  priority: number;
  start: number;
  end: number;
  match: string;
  reason: 'overlap';
  winnerRuleId: string;
  winnerRuleName: string;
  /** 被抑制命中的实体键（不参与编号分配，也不受实体决定影响） */
  entityKey: string;
}

export interface CueHit {
  index: number;
  id: string;
  start: string;
  end: string;
  payload: string;
  /** 纯文本 -> 原文 payload 的偏移映射 */
  map: number[];
  text: string;
  hits: Hit[];
  suppressed: SuppressedHit[];
}

/** 实体决策列表行：当前任务的实体 + 决定 + 命中统计 */
export interface EntitySummary {
  ruleId: string;
  /** 规则名；规则已删除时为空串（前端兜底显示「已删除规则」） */
  ruleName: string;
  /** 实体键：NFKC + trim 后的规范原文 */
  entityKey: string;
  /** 最近一次命中的原始文本（当前无命中时为空串） */
  sourceText: string;
  /** 当前实体决定；null = 待定 */
  decision: EntityDecisionAction | null;
  /** 决定时间（随决定持久化） */
  decidedAt?: string;
  /** 当前胜出命中数（被抑制命中不计入） */
  totalHits: number;
  appliedHits: number;
  revertedHits: number;
  /** 有显式例外的命中数 */
  exceptionHits: number;
}

export interface PreviewResult {
  cueCount: number;
  totalHits: number;
  appliedHits: number;
  revertedHits: number;
  suppressedHits: number;
  /** 有显式例外的胜出命中数 */
  exceptionHits: number;
  cues: CueHit[];
  parseErrors: string[];
  /** 计算后完整的化名表（已持久条目 + 本次首次命中新建条目） */
  aliases: AliasEntry[];
  /** 实体决策列表（当前命中实体 + 已持久决定的实体） */
  entities: EntitySummary[];
}

export interface PreviewInput {
  vtt: string;
  rules: MaskRule[];
  /** 旧版逐条撤销 key 列表（兼容字段，等价于 state=reverted 的例外） */
  revertedKeys?: string[];
  /** 逐条命中例外（显式覆盖实体决定） */
  hitExceptions?: HitException[];
  /** 实体级决定（持久化，新命中自动继承） */
  entityDecisions?: EntityDecision[];
  aliases?: AliasEntry[];
}

export interface AuditRecord {
  cueIndex: number;
  cueId: string;
  time: { start: string; end: string };
  rule: { id: string; name: string; priority: number };
  /** 原文区间（含纯文本偏移） */
  source: { start: number; end: number; text: string };
  /** 替换结果 */
  replacement: string;
  status: 'applied' | 'reverted' | 'suppressed';
  /** 被抑制时的胜出规则 */
  suppressedBy?: { id: string; name: string };
  /** 实体键（NFKC + trim 后的原文） */
  entityKey?: string;
  /** 化名模式：最终化名（含手动改名结果） */
  alias?: string;
  /** 最终状态的决策来源（被抑制命中无此字段） */
  decisionSource?: DecisionSource;
}

export interface AuditReport {
  app: string;
  version: number;
  generatedAt: string;
  source: {
    sha256: string;
    length: number;
    cueCount: number;
  };
  rules: MaskRule[];
  stats: {
    totalHits: number;
    appliedHits: number;
    revertedHits: number;
    suppressedHits: number;
    /** 有显式例外的胜出命中数 */
    exceptionHits: number;
  };
  records: AuditRecord[];
  /** 稳定化名表（实体键、最终化名、编号、是否自动生成） */
  aliases?: AliasEntry[];
  /** 导出时生效的实体级决定 */
  entityDecisions?: EntityDecision[];
}

export interface JobState {
  jobId: string;
  vtt: string;
  rules: MaskRule[];
  /** 逐条命中例外（显式覆盖实体决定，可清除恢复继承） */
  hitExceptions: HitException[];
  /** 实体级决定（规则 + 实体键 → 始终应用 / 始终保留） */
  entityDecisions: EntityDecision[];
  /** 稳定化名映射（持久化，编号不复用） */
  aliases: AliasEntry[];
  updatedAt: string;
}

export interface ExportResult {
  vtt: string;
  audit: AuditReport;
  jobId: string;
}
