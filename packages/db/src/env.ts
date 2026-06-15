import fs from "node:fs";
import path from "node:path";
import { parseEnvContent } from "@answer-generator/shared";

export function loadProjectEnv(startDir = process.cwd()) {
  const envPath = findUpEnv(startDir);
  if (!envPath) {
    return;
  }

  const entries = parseEnvContent(fs.readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(entries)) {
    process.env[key] ??= value;
  }
}

function findUpEnv(startDir: string): string | null {
  let currentDir = startDir;

  while (true) {
    const envPath = path.join(currentDir, ".env");
    if (fs.existsSync(envPath)) {
      return envPath;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}
