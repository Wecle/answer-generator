import { describe, expect, it } from "vitest";
import { parseEnvContent } from "../src/env";

describe("parseEnvContent", () => {
  it("parses simple env files with comments and quoted values", () => {
    expect(
      parseEnvContent(`
        # local config
        DATABASE_URL=postgresql://user:pass@localhost:5433/answer_generator
        OPENAI_API_KEY='token=value'
        OPENAI_MODEL="mimo-v2.5"

        EMPTY=
      `)
    ).toEqual({
      DATABASE_URL: "postgresql://user:pass@localhost:5433/answer_generator",
      OPENAI_API_KEY: "token=value",
      OPENAI_MODEL: "mimo-v2.5",
      EMPTY: ""
    });
  });
});
