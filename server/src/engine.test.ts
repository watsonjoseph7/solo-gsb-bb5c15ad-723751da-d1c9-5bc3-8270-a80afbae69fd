/** 引擎自测：node --import tsx src/engine.test.ts（通过 npm run test:engine 运行） */
import assert from 'assert';
import {
  autoAliasFor,
  buildPreview,
  exportResult,
  normalizeEntity,
  plainText,
} from './engine';
import { PRESETS, SAMPLE_VTT } from './presets';
import { migrateJobState } from './store';
import type { AliasEntry, EntityDecision, MaskRule } from './types';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function presetRule(name: string, override: Partial<MaskRule> = {}): MaskRule {
  const p = PRESETS.find((x) => x.rule.name === name)!;
  return { id: 'r-' + name, ...p.rule, ...override };
}

test('内联标签剥离与偏移映射', () => {
  const { text, map } = plainText('你好<00:00:01.000>世界<c.yellow>!</c>');
  assert.strictEqual(text, '你好世界!');
  assert.deepStrictEqual(map, [0, 1, 16, 17, 28]);
});

test('基础命中：手机号/邮箱/姓名', () => {
  const rules = [presetRule('手机号'), presetRule('邮箱'), presetRule('姓名')];
  const v = buildPreview({ vtt: SAMPLE_VTT, rules });
  assert.ok(v.totalHits >= 4, `应至少 4 个命中，实际 ${v.totalHits}`);
  const phone = v.cues[0].hits.find((h) => h.ruleName === '手机号')!;
  assert.strictEqual(phone.match, '13812345678');
  assert.strictEqual(phone.replacement, '138****5678');
  const name = v.cues[0].hits.find((h) => h.ruleName === '姓名')!;
  assert.strictEqual(name.match, '张伟');
  assert.strictEqual(name.replacement, '张*');
});

test('优先级合并：身份证(80) 吞并重叠的银行卡(75)', () => {
  const rules = [presetRule('身份证'), presetRule('银行卡')];
  const v = buildPreview({ vtt: SAMPLE_VTT, rules });
  // 18 位身份证数字同时落在银行卡 [16,19] 区间，两条规则在同一区间重叠
  const idCue = v.cues.find((c) => c.text.includes('110101'))!;
  assert.ok(idCue.suppressed.length >= 1, '应有被抑制命中');
  const sup = idCue.suppressed.find((s) => s.ruleName === '银行卡');
  assert.ok(sup, '银行卡应被身份证抑制（18 位重叠区间）');
  assert.strictEqual(sup!.winnerRuleName, '身份证');
});

test('19 位卡号不与身份证冲突，走银行卡规则', () => {
  const rules = [presetRule('身份证'), presetRule('银行卡')];
  const v = buildPreview({ vtt: SAMPLE_VTT, rules });
  const cardCue = v.cues.find((c) => c.text.includes('6222'))!;
  const bank = cardCue.hits.find((h) => h.ruleName === '银行卡');
  assert.ok(bank, '19 位卡号应由银行卡规则命中');
  assert.strictEqual(bank!.match, '6222021234567890123');
  assert.strictEqual(bank!.replacement, '6222********0123');
});

test('逐条撤销：key 稳定且导出恢复原文', () => {
  const rules = [presetRule('手机号')];
  const v1 = buildPreview({ vtt: SAMPLE_VTT, rules });
  const key = v1.cues[0].hits[0].key;
  const v2 = buildPreview({ vtt: SAMPLE_VTT, rules, revertedKeys: [key] });
  assert.strictEqual(v2.appliedHits, 1);
  assert.strictEqual(v2.revertedHits, 1);
  const ex = exportResult({ vtt: SAMPLE_VTT, rules, revertedKeys: [key] });
  assert.ok(!ex.vtt.includes('138****5678'), '撤销号码应保持原文');
  assert.ok(ex.vtt.includes('13812345678'));
  assert.ok(ex.vtt.includes('139****4321'), '未撤销号码应脱敏');
  assert.ok(ex.audit.records.some((r) => r.status === 'reverted'));
  assert.ok(ex.audit.records.some((r) => r.status === 'applied'));
});

test('时间轴/头部完整保留', () => {
  const vtt = 'WEBVTT\n\nNOTE\n这是备注\n\n00:00:01,000 --> 00:00:02,000  align:start\n电话 13812345678\n';
  const rules = [presetRule('手机号')];
  const ex = exportResult({ vtt, rules });
  assert.ok(ex.vtt.includes('NOTE'));
  assert.ok(ex.vtt.includes('00:00:01,000 --> 00:00:02,000  align:start'));
  assert.ok(ex.vtt.includes('电话 138****5678'));
  assert.strictEqual(ex.audit.source.cueCount, 1);
});

test('审计包含规则、原文区间与替换结果', () => {
  const rules = [presetRule('邮箱')];
  const ex = exportResult({ vtt: SAMPLE_VTT, rules });
  const rec = ex.audit.records.find((r) => r.rule.name === '邮箱')!;
  assert.strictEqual(rec.source.text, 'zhang.wei@example.com');
  assert.strictEqual(rec.replacement, '****@example.com');
  assert.strictEqual(typeof rec.source.start, 'number');
  assert.ok(rec.time.start && rec.time.end);
  assert.strictEqual(ex.audit.rules.length, 1);
  assert.ok(/^[a-f0-9]{64}$/.test(ex.audit.source.sha256));
});

test('非法正则在预览中报错而不崩溃', () => {
  const bad = { ...presetRule('手机号'), id: 'bad', pattern: '([0-9]+' };
  const v = buildPreview({ vtt: SAMPLE_VTT, rules: [bad] });
  assert.ok(v.parseErrors.some((e) => e.includes('bad')));
});

/* ---------------------------- 稳定化名 ---------------------------- */

const ALIAS_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
张伟先生到了。

00:00:02.500 --> 00:00:05.000
张伟先生和李娜女士一起。

00:00:05.500 --> 00:00:08.000
张伟先生先走，王芳女士留下。
`;

/** 稳定化名：同一实体跨 cue 使用同一编号化名 */
test('稳定化名：同一实体跨 cue 同一编号，不同实体依次编号', () => {
  const rule: MaskRule = { id: 'al', ...PRESETS.find((p) => p.rule.name === '姓名-稳定化名')!.rule, enabled: true };
  const v = buildPreview({ vtt: ALIAS_VTT, rules: [rule] });
  const all = v.cues.flatMap((c) => c.hits);
  const zhang = all.filter((h) => h.match === '张伟');
  const li = all.find((h) => h.match === '李娜')!;
  const wang = all.find((h) => h.match === '王芳')!;
  assert.strictEqual(zhang.length, 3);
  for (const h of zhang) {
    assert.strictEqual(h.alias, '人物1');
    assert.strictEqual(h.replacement, '人物1');
    assert.strictEqual(h.entityKey, '张伟');
  }
  assert.strictEqual(li.alias, '人物2');
  assert.strictEqual(wang.alias, '人物3');
  assert.deepStrictEqual(
    v.aliases.map((a) => [a.entityKey, a.seq, a.alias, a.auto]),
    [
      ['张伟', 1, '人物1', true],
      ['李娜', 2, '人物2', true],
      ['王芳', 3, '人物3', true],
    ],
  );
});

/** 持久化：把化名表回传后，增删其他字幕不会重排已有编号 */
test('稳定化名：回传映射后删减字幕，已有编号不重排', () => {
  const rule: MaskRule = { id: 'al', ...PRESETS.find((p) => p.rule.name === '姓名-稳定化名')!.rule, enabled: true };
  const v1 = buildPreview({ vtt: ALIAS_VTT, rules: [rule] });

  // 删除含李娜的整条 cue，张伟仍为人物1，王芳仍为人物3（不回收 2）
  const lines = ALIAS_VTT.split('\n');
  const cut = lines.filter((l) => !l.includes('李娜')).join('\n');
  const v2 = buildPreview({ vtt: cut, rules: [rule], aliases: v1.aliases });
  const names = v2.cues.flatMap((c) => c.hits.map((h) => [h.match, h.alias]));
  assert.deepStrictEqual(names, [
    ['张伟', '人物1'],
    ['张伟', '人物1'],
    ['王芳', '人物3'],
  ]);
  // 新实体拿到下一个编号 4
  const withNew = cut.replace('王芳女士', '赵敏女士');
  const v3 = buildPreview({ vtt: withNew, rules: [rule], aliases: v1.aliases });
  const zhao = v3.cues.flatMap((c) => c.hits).find((h) => h.match === '赵敏')!;
  assert.strictEqual(zhao.alias, '人物4');
});

/** 实体键规范化：NFKC（全角→半角等）+ trim，跨 cue 收敛同一实体 */
test('稳定化名：NFKC 与首尾空白规范化实体键', () => {
  assert.strictEqual(normalizeEntity(' ＡＢＣ '), 'ABC');
  const rule: MaskRule = {
    id: 'code',
    name: '代号',
    pattern: '[A-Za-z0-9Ａ-ｚ０-９]{2,}',
    flags: 'g',
    replacement: '',
    priority: 10,
    enabled: true,
    mode: 'alias',
    aliasPrefix: '代号',
  };
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:01.000
代号 abc12

00:00:02.000 --> 00:00:03.000
代号 ａｂｃ１２
`;
  const v = buildPreview({ vtt, rules: [rule] });
  const hits = v.cues.flatMap((c) => c.hits);
  assert.strictEqual(hits.length, 2);
  assert.strictEqual(hits[0].entityKey, 'abc12');
  assert.strictEqual(hits[1].entityKey, 'abc12');
  assert.strictEqual(hits[0].alias, hits[1].alias);
  assert.strictEqual(hits[0].alias, '代号1');
});

/** 手动改名：回传自定义化名后，所有未撤销命中立即联动 */
test('稳定化名：手动改名联动全部未撤销命中，撤销处恢复原文', () => {
  const rule: MaskRule = { id: 'al', ...PRESETS.find((p) => p.rule.name === '姓名-稳定化名')!.rule, enabled: true };
  const v1 = buildPreview({ vtt: ALIAS_VTT, rules: [rule] });
  const renamed: AliasEntry[] = v1.aliases.map((a) =>
    a.entityKey === '张伟' ? { ...a, alias: '客户甲', auto: false } : a,
  );
  const zhangKey = v1.cues[0].hits.find((h) => h.match === '张伟')!.key;
  const v2 = buildPreview({
    vtt: ALIAS_VTT,
    rules: [rule],
    aliases: renamed,
    revertedKeys: [zhangKey],
  });
  const zhang = v2.cues.flatMap((c) => c.hits).filter((h) => h.match === '张伟');
  assert.strictEqual(zhang[0].reverted, true);
  assert.strictEqual(zhang[0].replacement, '客户甲'); // 改名仍联动，撤销只控制是否替换
  assert.ok(zhang.slice(1).every((h) => h.replacement === '客户甲'));
  assert.strictEqual(v2.revertedHits, 1);
  assert.strictEqual(v2.appliedHits, zhang.length - 1 + 2);

  const ex = exportResult({ vtt: ALIAS_VTT, rules: [rule], aliases: renamed, revertedKeys: [zhangKey] });
  assert.ok(ex.vtt.includes('张伟先生到了'), '撤销处保留原文');
  assert.ok(!ex.vtt.includes('人物1'));
  assert.ok(ex.vtt.includes('客户甲先生和'));
  // 审计记录实体键、最终化名、状态
  const recs = ex.audit.records.filter((r) => r.entityKey === '张伟');
  assert.ok(recs.some((r) => r.status === 'reverted' && r.alias === '客户甲'));
  assert.ok(recs.some((r) => r.status === 'applied' && r.alias === '客户甲'));
  assert.ok(ex.audit.aliases!.some((a) => a.entityKey === '张伟' && a.alias === '客户甲'));
});

/** 前缀变更：自动化名跟随新前缀，手动改名保持不变 */
test('稳定化名：前缀调整联动自动条目，自定义条目不受影响', () => {
  const base: MaskRule = { id: 'al', ...PRESETS.find((p) => p.rule.name === '姓名-稳定化名')!.rule, enabled: true };
  const v1 = buildPreview({ vtt: ALIAS_VTT, rules: [base] });
  const aliases: AliasEntry[] = v1.aliases.map((a) =>
    a.entityKey === '李娜' ? { ...a, alias: '当事人', auto: false } : a,
  );
  const renamedRule = { ...base, aliasPrefix: '受访者' };
  const v2 = buildPreview({ vtt: ALIAS_VTT, rules: [renamedRule], aliases });
  const byKey = new Map(v2.aliases.map((a) => [a.entityKey, a.alias]));
  assert.strictEqual(byKey.get('张伟'), '受访者1');
  assert.strictEqual(byKey.get('李娜'), '当事人');
  assert.strictEqual(byKey.get('王芳'), '受访者3');
  assert.strictEqual(autoAliasFor('受访者', 3), '受访者3');
});

/** 模板规则与化名规则并存，重叠抑制语义不变 */
test('稳定化名：与模板规则并存，优先级抑制照常', () => {
  const tpl: MaskRule = {
    id: 'tpl',
    name: '姓名打码',
    pattern: '张伟',
    flags: 'g',
    replacement: '张*',
    priority: 40,
    enabled: true,
    mode: 'template',
    aliasPrefix: '人物',
  };
  const alias: MaskRule = {
    id: 'al',
    ...PRESETS.find((p) => p.rule.name === '姓名-稳定化名')!.rule,
    enabled: true,
    priority: 10,
  };
  const v = buildPreview({ vtt: ALIAS_VTT, rules: [tpl, alias] });
  const firstCue = v.cues[0];
  assert.strictEqual(firstCue.hits[0].replacement, '张*');
  assert.ok(firstCue.suppressed.some((s) => s.ruleName === '姓名-稳定化名' && s.entityKey === '张伟'));
});

/* ---------------------------- 实体决策 ---------------------------- */

const DECIDE_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
客服张伟先生，工号 1001。

00:00:02.500 --> 00:00:05.000
张伟先生再次来电。
`;

function keepDecision(ruleId: string, entityKey: string): EntityDecision {
  return { ruleId, entityKey, action: 'keep', decidedAt: '2026-09-19T00:00:00.000Z' };
}

/** 始终保留：同实体全部命中保留原文，后续新出现的同实体命中自动继承 */
test('实体决策：始终保留作用于同实体全部命中，新命中自动继承', () => {
  const rule = presetRule('姓名');
  const decisions = [keepDecision(rule.id, '张伟')];
  const v1 = buildPreview({ vtt: DECIDE_VTT, rules: [rule], entityDecisions: decisions });
  const zhang = v1.cues.flatMap((c) => c.hits).filter((h) => h.match === '张伟');
  assert.strictEqual(zhang.length, 2);
  assert.ok(zhang.every((h) => h.reverted && h.decisionSource === 'entity'));

  // 新增一条含同实体的 cue：无需任何操作即继承保留
  const more = DECIDE_VTT + '\n00:00:06.000 --> 00:00:08.000\n张伟先生三顾茅庐。\n';
  const v2 = buildPreview({ vtt: more, rules: [rule], entityDecisions: decisions });
  const zhang2 = v2.cues.flatMap((c) => c.hits).filter((h) => h.match === '张伟');
  assert.strictEqual(zhang2.length, 3);
  assert.ok(zhang2.every((h) => h.reverted && h.decisionSource === 'entity'));

  // 导出 VTT 与预览同一最终状态：全部保留原文
  const ex = exportResult({ vtt: DECIDE_VTT, rules: [rule], entityDecisions: decisions });
  assert.ok(ex.vtt.includes('张伟先生'));
  assert.ok(!ex.vtt.includes('张*'));
});

/** 始终应用 + 逐条例外：例外优先于实体决定，清除例外后恢复继承 */
test('实体决策：逐条例外优先于实体决定，清除后恢复继承', () => {
  const rule = presetRule('姓名');
  const decisions = [keepDecision(rule.id, '张伟')];
  const v1 = buildPreview({ vtt: DECIDE_VTT, rules: [rule], entityDecisions: decisions });
  const target = v1.cues[0].hits.find((h) => h.match === '张伟')!;
  assert.ok(target.reverted);

  // 对该命中写入显式「应用」例外：覆盖实体保留决定
  const v2 = buildPreview({
    vtt: DECIDE_VTT,
    rules: [rule],
    entityDecisions: decisions,
    hitExceptions: [{ key: target.key, state: 'applied' }],
  });
  const t2 = v2.cues[0].hits.find((h) => h.key === target.key)!;
  assert.strictEqual(t2.reverted, false);
  assert.strictEqual(t2.decisionSource, 'exception');
  // 其余同实体命中仍继承保留
  const others = v2.cues
    .flatMap((c) => c.hits)
    .filter((h) => h.match === '张伟' && h.key !== target.key);
  assert.ok(others.length === 1 && others.every((h) => h.reverted && h.decisionSource === 'entity'));

  // 清除例外：恢复继承实体保留决定
  const v3 = buildPreview({
    vtt: DECIDE_VTT,
    rules: [rule],
    entityDecisions: decisions,
    hitExceptions: [],
  });
  assert.ok(v3.cues[0].hits.find((h) => h.key === target.key)!.reverted);

  // 反向：实体决定为始终应用，逐条撤销例外使其保留原文
  const applyDecisions: EntityDecision[] = [
    { ruleId: rule.id, entityKey: '张伟', action: 'apply', decidedAt: '2026-09-19T00:00:00.000Z' },
  ];
  const v4 = buildPreview({
    vtt: DECIDE_VTT,
    rules: [rule],
    entityDecisions: applyDecisions,
    hitExceptions: [{ key: target.key, state: 'reverted' }],
  });
  const t4 = v4.cues[0].hits.find((h) => h.key === target.key)!;
  assert.ok(t4.reverted && t4.decisionSource === 'exception');
  const inherited = v4.cues.flatMap((c) => c.hits).filter((h) => h.match === '张伟' && h.key !== target.key);
  assert.ok(inherited.every((h) => !h.reverted && h.decisionSource === 'entity'));
});

/** 实体键 NFKC 归一：全角 / 半角写法收敛为同一实体，决定一并继承（模板规则同样生效） */
test('实体决策：NFKC 归一后同实体跨写法继承决定', () => {
  const rule: MaskRule = {
    id: 'num',
    name: '编号',
    pattern: '[0-9０-９]{4}',
    flags: 'g',
    replacement: '****',
    priority: 10,
    enabled: true,
    mode: 'template',
    aliasPrefix: '',
  };
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n编号 1234 与 １２３４\n';
  const v = buildPreview({
    vtt,
    rules: [rule],
    entityDecisions: [keepDecision('num', '1234')],
  });
  const hits = v.cues[0].hits;
  assert.strictEqual(hits.length, 2);
  assert.ok(hits.every((h) => h.entityKey === '1234'));
  assert.ok(hits.every((h) => h.reverted && h.decisionSource === 'entity'));
});

/** 重叠合并后实体决定只对胜出命中生效；被抑制命中不生成例外、不受决定影响 */
test('实体决策：被抑制命中不受影响，决定只作用于胜出命中', () => {
  const idRule = presetRule('身份证');
  const bankRule = presetRule('银行卡');
  const idVtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n身份证号 110101199003071234 登记。\n';
  const decisions = [keepDecision(bankRule.id, normalizeEntity('110101199003071234'))];

  // 身份证(80) 胜出，银行卡被抑制：保留决定不落在任何胜出命中上
  const v1 = buildPreview({ vtt: idVtt, rules: [idRule, bankRule], entityDecisions: decisions });
  assert.ok(v1.cues[0].suppressed.some((s) => s.ruleName === '银行卡'));
  assert.strictEqual(v1.revertedHits, 0);
  assert.strictEqual(v1.exceptionHits, 0);
  const idHit = v1.cues[0].hits.find((h) => h.ruleName === '身份证')!;
  assert.ok(!idHit.reverted && idHit.decisionSource === 'default');

  // 规则变化（身份证停用）后银行卡成为胜出命中，继承保留决定
  const v2 = buildPreview({
    vtt: idVtt,
    rules: [{ ...idRule, enabled: false }, bankRule],
    entityDecisions: decisions,
  });
  const bank = v2.cues[0].hits.find((h) => h.ruleName === '银行卡')!;
  assert.ok(bank.reverted && bank.decisionSource === 'entity');
});

/** 审计：每条记录携带决策来源，报告含实体决定与例外统计，导出与预览同一最终状态 */
test('实体决策：审计记录决策来源，导出与预览状态一致', () => {
  const rule = presetRule('姓名');
  const decisions = [keepDecision(rule.id, '张伟')];
  const v1 = buildPreview({ vtt: DECIDE_VTT, rules: [rule], entityDecisions: decisions });
  const exKey = v1.cues[0].hits.find((h) => h.match === '张伟')!.key;
  const input = {
    vtt: DECIDE_VTT,
    rules: [rule],
    entityDecisions: decisions,
    hitExceptions: [{ key: exKey, state: 'applied' as const }],
  };
  const ex = exportResult(input);
  const recs = ex.audit.records.filter((r) => r.entityKey === '张伟');
  assert.ok(recs.some((r) => r.status === 'applied' && r.decisionSource === 'exception'));
  assert.ok(recs.some((r) => r.status === 'reverted' && r.decisionSource === 'entity'));
  assert.strictEqual(ex.audit.version, 3);
  assert.strictEqual(ex.audit.stats.exceptionHits, 1);
  assert.ok(ex.audit.entityDecisions!.some((d) => d.entityKey === '张伟' && d.action === 'keep'));
  // 导出 VTT 与预览最终状态一致：例外处替换，其余保留
  assert.ok(ex.vtt.includes('张*先生'));
  assert.ok(ex.vtt.includes('张伟先生再次来电'));
});

/** 实体决策列表：汇总命中 / 例外统计，包含当前无命中的持久决定 */
test('实体决策：实体列表汇总统计，含未命中实体的持久决定', () => {
  const rule = presetRule('姓名');
  const decisions: EntityDecision[] = [
    keepDecision(rule.id, '张伟'),
    { ruleId: rule.id, entityKey: '李四', action: 'apply', decidedAt: '2026-09-19T00:00:00.000Z' },
  ];
  const v1 = buildPreview({ vtt: DECIDE_VTT, rules: [rule], entityDecisions: decisions });
  const zw = v1.entities.find((e) => e.entityKey === '张伟')!;
  assert.strictEqual(zw.decision, 'keep');
  assert.strictEqual(zw.totalHits, 2);
  assert.strictEqual(zw.revertedHits, 2);
  assert.strictEqual(zw.exceptionHits, 0);
  // 当前无命中但已持久决定的实体也列出（决定对未来命中生效）
  const ls = v1.entities.find((e) => e.entityKey === '李四')!;
  assert.strictEqual(ls.totalHits, 0);
  assert.strictEqual(ls.decision, 'apply');

  // 写入一条例外后：实体的例外计数与全局例外计数联动
  const key = v1.cues[0].hits.find((h) => h.match === '张伟')!.key;
  const v2 = buildPreview({
    vtt: DECIDE_VTT,
    rules: [rule],
    entityDecisions: decisions,
    hitExceptions: [{ key, state: 'applied' }],
  });
  assert.strictEqual(v2.entities.find((e) => e.entityKey === '张伟')!.exceptionHits, 1);
  assert.strictEqual(v2.exceptionHits, 1);
});

/** 兼容：旧版 revertedKeys 仍按逐条「撤销」例外生效 */
test('兼容：旧版 revertedKeys 作为逐条撤销例外生效', () => {
  const rules = [presetRule('手机号')];
  const v1 = buildPreview({ vtt: SAMPLE_VTT, rules });
  const key = v1.cues[0].hits[0].key;
  const v2 = buildPreview({ vtt: SAMPLE_VTT, rules, revertedKeys: [key] });
  const h = v2.cues[0].hits[0];
  assert.ok(h.reverted && h.decisionSource === 'exception');
  // 显式例外与旧字段并存时，显式例外优先
  const v3 = buildPreview({
    vtt: SAMPLE_VTT,
    rules,
    revertedKeys: [key],
    hitExceptions: [{ key, state: 'applied' }],
  });
  assert.ok(!v3.cues[0].hits[0].reverted);
});

/** 兼容：旧 job.json（revertedKeys 时代）迁移为逐条例外与空实体决定 */
test('兼容：旧 job.json 迁移为逐条例外与空实体决定', () => {
  const migrated = migrateJobState({
    jobId: 'j1',
    vtt: 'WEBVTT',
    rules: [],
    revertedKeys: ['k1', 'k2'],
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepStrictEqual(migrated.hitExceptions, [
    { key: 'k1', state: 'reverted' },
    { key: 'k2', state: 'reverted' },
  ]);
  assert.deepStrictEqual(migrated.entityDecisions, []);
  assert.deepStrictEqual(migrated.aliases, []);

  // 新格式存在时优先，旧字段不再生效
  const m2 = migrateJobState({
    hitExceptions: [{ key: 'x', state: 'applied' }],
    entityDecisions: [{ ruleId: 'r', entityKey: 'e', action: 'keep', decidedAt: 't' }],
    revertedKeys: ['k1'],
  });
  assert.deepStrictEqual(m2.hitExceptions, [{ key: 'x', state: 'applied' }]);
  assert.strictEqual(m2.entityDecisions.length, 1);
});

console.log(`\n引擎自测全部通过（${passed} 项）`);
