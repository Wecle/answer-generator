# 评分标准编译模型拆分设计

## 背景

当前所有 AI 流程共用 `OPENAI_MODEL`。将其切换为 `deepseek-v4-flash` 后，长评分标准虽然能够通过 Strict Function Calling 返回合法 JSON，但在编译和结构修复时仍可能遗漏业务必填内容，例如为多个维度返回空的 `pitfalls`。Strict Mode 无法弥补这一点，因为 DeepSeek 不支持用 `minItems` 约束数组非空。

评分标准编译、结构修复和覆盖审计需要更强的语义遵循能力；答案生成、答案审核和文档解析则可以继续使用速度更快、成本更低的 Flash 模型。

## 决策

新增可选环境变量 `RUBRIC_COMPILER_MODEL`，只控制以下流程：

- 初次评分标准编译；
- 无效候选结构修复；
- 确定性校验或覆盖审计后的定向修复；
- 评分标准覆盖审计。

其余 AI 流程继续读取 `OPENAI_MODEL`。

推荐配置：

```env
OPENAI_MODEL=deepseek-v4-flash
RUBRIC_COMPILER_MODEL=deepseek-v4-pro
```

## 配置解析与兼容性

评分标准编译器按以下优先级解析模型：

1. 非空的 `RUBRIC_COMPILER_MODEL`；
2. 非空的 `OPENAI_MODEL`；
3. 既有默认值 `gpt-4o-mini`。

不新增独立的 API key 或 base URL。编译器继续共用 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL`，因此不会引入跨供应商路由或额外密钥管理。

未配置 `RUBRIC_COMPILER_MODEL` 的现有部署行为不变。

## 数据与错误行为

最终 `rubric_schema.compilation.compiler_model`、`auditor_model` 以及 `CompileRubricResponse` 中的模型字段必须记录实际使用的编译模型，而不是全局 `OPENAI_MODEL`。

模型调用失败继续沿用现有阶段化错误和响应正文诊断，不增加静默重试或自动切换模型。Flash 返回不完整语义时，也不放宽每个维度至少一个 `criterion` 和 `pitfall` 的业务规则。

## 配置入口

需要同步更新：

- 根目录 `.env.example` 和 `.env.production.example`；
- `docker-compose.yml` 的 API 服务环境变量；
- 英文与中文 README 的示例和环境变量表；
- 本地未纳入版本控制的 `.env`，将编译模型设置为 `deepseek-v4-pro`。

## 测试

API 测试必须覆盖：

- 设置 `RUBRIC_COMPILER_MODEL` 时，编译、修复和审计请求都使用该模型；
- 未设置时回退到 `OPENAI_MODEL`；
- 返回的编译元数据记录实际模型；
- 现有 Strict Function Calling、结构修复预算和全量 API 测试继续通过。

## 非目标

- 不为答案生成、审核或文档解析增加独立模型变量；
- 不改变评分标准 Schema 或放宽非空数组约束；
- 不自动在 Pro 与 Flash 之间重试；
- 不重新运行失败任务或产生长文本模型费用。
