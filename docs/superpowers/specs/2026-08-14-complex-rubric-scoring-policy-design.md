# 复杂评分标准与归一化规则设计

## 背景

当前 Rubric Schema v2 只能表达固定分值维度，并要求所有维度 `max_score` 合计为 100。该结构无法忠实表示以下常见评分规则：

- 基础分与额外加分并存；
- 加分值是区间而不是固定值；
- 掉档、封顶、扣分和一票否决；
- 原文标题档位与逐项分值之间存在数值冲突。

任务 `f99f8143-7744-4055-845a-a6c60ce4dd40` 的原始规则包含基础层 75 分、多个区间加分项、掉档和扣分规则。编译模型为了满足固定 100 分约束，将区间加分合并为固定维度分值；覆盖审计正确识别到语义失真，并在修复后仍拒绝 Schema。

本设计扩展现有 v2 Schema，使解析器忠实保存原始规则，再通过独立、可解释的归一化规则换算为系统使用的 100 分制。

## 目标

- 忠实保存固定分、区间加分、扣分、掉档、封顶和否决规则。
- 允许记录原文自身的数值冲突，不要求模型擅自消解冲突。
- 由服务端计算归一化分数，模型不能直接决定最终总分。
- 保持历史 Rubric Schema v2 和历史任务行为不变。
- 继续使用现有 JSON 存储，不增加数据库迁移。

## 非目标

- 不自动改写用户的原始评分标准。
- 不为没有明确数值的规则编造扣分或加分。
- 不升级到 Rubric Schema v3。
- 不在本次修改中重新设计评分结果页面。
- 不自动重新运行失败任务。

## Schema 扩展

`RubricSchemaV2` 和编译候选新增可选字段 `scoring_policy`。未提供该字段的 Schema 继续采用现有固定 100 分行为。

### 评分策略

```json
{
  "mode": "normalized_rules",
  "base_max_score": 75,
  "bonus_rules": [],
  "penalty_rules": [],
  "score_conflicts": [],
  "normalization": {
    "raw_max_score": 97,
    "target_max_score": 100,
    "method": "linear"
  }
}
```

`mode` 支持：

- `fixed_total`：历史行为，固定维度满分合计必须为 100；
- `normalized_rules`：基础维度、加分和扣分规则分开表达，最终换算为 100 分。

`scoring_policy` 缺失时等价于 `fixed_total`。

### 加分规则

```json
{
  "id": "BONUS-001",
  "text": "有画面",
  "min_score": 2,
  "max_score": 4,
  "source_requirement_ids": ["REQ-039"]
}
```

每条加分规则保留原文区间。未达到加分条件时实际得分可以为 0；达到条件后的非零得分必须位于 `min_score` 与 `max_score` 之间。

### 扣分与否决规则

```json
{
  "id": "PEN-001",
  "text": "答非所问直接掉到60-70分",
  "effect": "set_range",
  "min_score": 60,
  "max_score": 70,
  "source_requirement_ids": ["REQ-046"]
}
```

`effect` 支持：

- `deduct`：扣除明确分值；
- `cap`：归一化总分不得超过指定值；
- `set_range`：将最终分数限制到原文给定区间；
- `veto`：直接判定不通过；
- `qualitative`：原文未提供数值，只记录触发与原因，不改变分数。

数值字段按 effect 使用：`deduct` 使用 `score`，`cap` 使用 `max_score`，`set_range` 使用 `min_score` 和 `max_score`，`veto` 与 `qualitative` 不要求数值。

### 原文冲突

```json
{
  "text": "档位标题最高90分，但逐项加分上限与基础分合计为97分",
  "source_requirement_ids": ["REQ-039", "REQ-045"]
}
```

冲突必须同时保留冲突双方的来源映射。覆盖审计在确认冲突被忠实记录后可以通过，不要求编译模型选择其中一方或伪造固定权重。

### 归一化

对于 `normalized_rules`：

```text
raw_score = base_dimension_score + awarded_bonus_score
normalized_score = round(raw_score / raw_max_score × target_max_score)
```

其中：

- `base_max_score` 必须等于基础维度 `max_score` 之和；
- `raw_max_score` 必须等于 `base_max_score` 加所有加分规则的 `max_score`；
- `target_max_score` 固定为 100；
- `method` 当前只支持 `linear`；
- 归一化结果限制在 0 到 100。

当原文档位标题与明细上限冲突时，`raw_max_score` 使用可逐项计算的明细上限，同时在 `score_conflicts` 中保留标题冲突。这样归一化是确定性的，但不会把冲突从解析结果中抹掉。

## 编译和覆盖审计

编译器必须判断原文属于哪种评分结构：

- 只有固定分且合计明确为 100：省略 `scoring_policy` 或使用 `fixed_total`；
- 存在基础分、区间加分、扣分、掉档或否决规则：使用 `normalized_rules`。

编译提示必须明确禁止把区间加分合并成固定维度分值。区间加分进入 `bonus_rules`，扣分、掉档和否决进入 `penalty_rules`。

覆盖审计需要逐项检查：

- 固定维度、加分和惩罚规则是否分别映射原文；
- 区间端点是否忠实；
- 分值规则是否被弱化为普通 pitfall 文本；
- 原文冲突是否进入 `score_conflicts`；
- 归一化参数是否可以由已保存的明细确定性计算。

已被完整记录的原文冲突不再构成覆盖失败。遗漏冲突、擅自选择冲突一方或自行添加分值仍构成覆盖失败。

## 确定性校验

公共校验继续检查 ID 唯一性、来源引用、完整映射、维度和规则字段合法性。

`fixed_total`：

- 维度固定满分合计必须为 100。

`normalized_rules`：

- 维度固定满分合计必须等于 `base_max_score`；
- 加分规则满足 `0 <= min_score <= max_score`；
- `raw_max_score` 等于基础满分与加分上限之和；
- `target_max_score` 必须为 100；
- penalty effect 与所需数值字段一致；
- bonus、penalty 和 conflict 均有非空来源映射；
- 所有来源要求至少映射到维度、criterion、pitfall、global constraint、bonus、penalty 或 conflict 之一。

## 生成 Prompt

答案生成 Prompt 将评分约束分成三块：

- 固定评分维度及其 criteria、pitfalls；
- 可争取的加分规则及区间；
- 必须避免的扣分、掉档和否决规则。

`score_conflicts` 和归一化公式不要求答案文本主动讨论，仅作为评分系统元数据。

## 审核与计分

AI 审核响应只负责返回事实性分项：

- 每个固定维度的得分；
- 每个 bonus rule 是否触发及实际加分；
- 每个 penalty rule 是否触发及原因；
- criterion 的失败、保留和修复信息。

服务端不接受模型声明的最终总分，而是执行：

1. 汇总固定维度得分；
2. 校验并汇总加分；
3. 计算归一化分数；
4. 依次应用 `deduct`、`cap`、`set_range`；
5. 应用 `veto` 的不通过结论；
6. 将最终 0–100 分与任务 `passing_score` 比较。

`set_range` 的确定性规则为：触发后将当前分数限制在 `[min_score, max_score]`；低于下限时保持当前较低分数，高于上限时封顶到 `max_score`。服务端不凭空把低分提升到区间下限。

`qualitative` 只进入审核原因，不改变最终分数。

评分响应和持久化记录新增：

- 基础维度合计；
- 每项实际加分；
- 触发的 penalty 及原因；
- 原始总分；
- 归一化分数；
- 最终分数；
- 是否被 veto。

## 本地审核兜底

没有 AI 审核结果时，本地审核器继续按 criterion 命中率计算基础维度分。它不会猜测主观加分，因此所有 bonus 得 0；只应用可以确定性检测的规则。无法可靠判断的 penalty 和 qualitative rule 进入说明，不擅自扣分。

该行为可能保守低估分数，但不会伪造原文没有提供的分值。

## 兼容与数据流

- `scoring_policy` 是 v2 的可选字段，历史 JSON 不需要迁移。
- Shared TypeScript 类型与运行时校验器接受两种模式。
- Worker 在 API 载荷中保留 scoring policy 和新增的评分分项。
- 现有固定 100 分任务的生成、审核、重试和持久化行为保持不变。
- 编译元数据继续记录实际 compiler 和 auditor 模型。

## 错误处理

以下情况在确定性校验阶段失败，不进入无意义的覆盖修复循环：

- 基础维度合计与 `base_max_score` 不一致；
- 区间上下限颠倒；
- `raw_max_score` 与规则明细不一致；
- penalty effect 缺少必要数值；
- 规则 ID、来源引用或映射不合法。

覆盖审计仅处理忠实度问题。原文冲突完整记录后允许通过；未记录或被擅自消解时返回精确的 requirement ID 与 schema path。

## 测试策略

需要覆盖：

- 75 分基础层、区间加分、掉档和定性扣分可成功编译；
- 原文档位 90 与明细上限 97 的冲突被记录但不导致审计死循环；
- 固定 100 分历史 Schema 仍通过并保持旧评分结果；
- bonus 为 0 或位于合法区间，越界结果被拒绝；
- linear 归一化和 0–100 边界；
- deduct、cap、set_range、veto、qualitative 的独立行为；
- 最终分由服务端重算，忽略模型声称的总分；
- Prompt 包含加分和 penalty 规则；
- API Pydantic、Shared 运行时校验、Worker 映射和类型检查一致；
- API、Shared、Worker、Web 全量回归测试通过。
