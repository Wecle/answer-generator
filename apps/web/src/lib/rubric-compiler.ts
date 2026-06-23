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

  const response = await fetch(`${aiServiceUrl}/ai/compile-rubric`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rubric: input.rubric,
      answer_minutes: input.answerMinutes,
      passing_score: input.passingScore
    })
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = (await response.json()) as CompileRubricResponse;
  return {
    compiledPrompt: payload.compiled_prompt,
    rubricSchema: toCamelSchema(payload.rubric_schema)
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
