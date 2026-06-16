export interface RubricSchema {
  rolePrompt: string;
  answerPrinciples: string[];
  dimensions: Array<{ name: string; maxScore: number; criteria: string[]; pitfalls: string[] }>;
  retryPolicy: string[];
  outputRules: string[];
}

interface CompileRubricResponse {
  compiled_prompt: string;
  rubric_schema: {
    role_prompt: string;
    answer_principles: string[];
    dimensions: Array<{ name: string; max_score: number; criteria: string[]; pitfalls: string[] }>;
    retry_policy: string[];
    output_rules: string[];
  };
}

export async function compileRubricForJob(input: {
  rubric: string;
  answerMinutes: number;
  passingScore: number;
}) {
  const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8001";

  try {
    const response = await fetch(`${aiServiceUrl}/ai/compile-rubric`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rubric: input.rubric,
        answer_minutes: input.answerMinutes,
        passing_score: input.passingScore
      })
    });

    if (response.ok) {
      const payload = (await response.json()) as CompileRubricResponse;
      return {
        compiledPrompt: payload.compiled_prompt,
        rubricSchema: toCamelSchema(payload.rubric_schema)
      };
    }
  } catch {
    // Fallback below keeps task creation available while the AI service starts.
  }

  const rubricSchema = compileLocally(input.rubric, input.answerMinutes, input.passingScore);
  return {
    compiledPrompt: buildCompiledPrompt(rubricSchema, input.answerMinutes, input.passingScore),
    rubricSchema
  };
}

function toCamelSchema(schema: CompileRubricResponse["rubric_schema"]): RubricSchema {
  return {
    rolePrompt: schema.role_prompt,
    answerPrinciples: schema.answer_principles,
    dimensions: schema.dimensions.map((dimension) => ({
      name: dimension.name,
      maxScore: dimension.max_score,
      criteria: dimension.criteria,
      pitfalls: dimension.pitfalls
    })),
    retryPolicy: schema.retry_policy,
    outputRules: schema.output_rules
  };
}

function compileLocally(rubric: string, answerMinutes: number, passingScore: number): RubricSchema {
  const dimensions = parseDimensions(rubric);
  return {
    rolePrompt: "你是一名参加公务员结构化面试的考生，需要按照用户给出的评分标准进行作答。",
    answerPrinciples: [
      "只围绕用户评分标准展开。",
      "每个评分维度都要有对应观点、分析或做法。",
      `答案需要适合 ${answerMinutes} 分钟内口述，通过线为 ${passingScore} 分。`
    ],
    dimensions,
    retryPolicy: ["优先补齐低分维度和缺失条目。", "保留已覆盖内容，定向改写低分部分。"],
    outputRules: ["输出纯文本。", "不使用 Markdown。", "多题目时按“第 1 题”分段。"]
  };
}

function parseDimensions(rubric: string): RubricSchema["dimensions"] {
  const lines = rubric.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const dimensions: RubricSchema["dimensions"] = [];
  let current: RubricSchema["dimensions"][number] | null = null;

  for (const line of lines) {
    const score = extractScore(line);
    if (score !== null) {
      if (current) dimensions.push(current);
      current = { name: compactDimensionName(line), maxScore: score, criteria: [], pitfalls: [] };
      continue;
    }

    if (current) {
      current.criteria.push(line);
      current.pitfalls.push(`缺少或空泛处理：${line}`);
    }
  }

  if (current) dimensions.push(current);
  if (dimensions.length > 0) return normalizeScores(dimensions);

  const criteria = lines.length ? lines : [rubric.trim()];
  return [{ name: "用户评分标准", maxScore: 100, criteria, pitfalls: criteria.map((item) => `缺少或空泛处理：${item}`) }];
}

function normalizeScores(dimensions: RubricSchema["dimensions"]) {
  const total = dimensions.reduce((sum, item) => sum + item.maxScore, 0);
  if (total === 100 || total <= 0) return dimensions;
  return dimensions.map((item) => ({ ...item, maxScore: Math.round((item.maxScore / total) * 100) }));
}

function buildCompiledPrompt(schema: RubricSchema, answerMinutes: number, passingScore: number) {
  return [
    schema.rolePrompt,
    `答题时间为 ${answerMinutes} 分钟，通过分数为 ${passingScore} 分。`,
    "评分维度：",
    ...schema.dimensions.map((dimension) => `- ${dimension.name}（${dimension.maxScore}分）：${dimension.criteria.join("；")}`)
  ].join("\n");
}

function cleanLine(value: string) {
  return value
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)、]\s+/, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`/g, "")
    .trim();
}

function extractScore(value: string) {
  const match = value.match(/(?:满分)?\s*(\d{1,3})\s*分/);
  if (!match) return null;
  const score = Number(match[1]);
  return score > 0 && score <= 100 ? score : null;
}

function compactDimensionName(value: string) {
  return value
    .replace(/[（(]?\s*(满分)?\s*\d+\s*分\s*[)）]?/g, "")
    .replace(/^维度[一二三四五六七八九十\d]+[：:、\s]*/, "")
    .replace(/[：: -]+$/g, "")
    .trim()
    .slice(0, 28) || "用户评分标准";
}
