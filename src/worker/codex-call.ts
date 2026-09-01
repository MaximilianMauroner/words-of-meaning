import { Codex } from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { workerEnvelopeSchema } from "../shared/worker";
import { modelPrompt, outputSchema } from "../server/runner/prompts";

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function fakeCall(envelope: ReturnType<typeof workerEnvelopeSchema.parse>) {
  const delay = Number(process.env.WORDS_FAKE_DELAY_MS || 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  if (envelope.kind === "generate") {
    const hue = [...envelope.prompt].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 360;
    if (envelope.artifactFormat === "plain_html_css") {
      await writeFile(path.join(process.cwd(), "index.html"), `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Preview</title><link rel="stylesheet" href="styles.css"></head><body><main><h1>Preview</h1><p>Static design</p></main></body></html>\n`);
      await writeFile(path.join(process.cwd(), "styles.css"), `:root { color-scheme: light; }\nbody { margin: 0; font: 16px system-ui; }\nmain { max-width: 48rem; margin: 4rem auto; color: hsl(${hue} 45% 35%); }\n`);
      return { threadId: randomUUID(), finalResponse: "Created the static HTML and CSS files.", usage: null };
    }
    await writeFile(path.join(process.cwd(), "App.tsx"), `export function App() {\n  return <main style={{ color: \"hsl(${hue} 45% 35%)\" }}>Settings</main>;\n}\n`);
    await writeFile(path.join(process.cwd(), "styles.css"), `main { max-width: 48rem; margin: 4rem auto; }\n`);
    return { threadId: randomUUID(), finalResponse: "Created the source files.", usage: null };
  }
  if (envelope.kind === "classify") {
    const probability = 1 / envelope.candidates.length;
    return {
      threadId: randomUUID(),
      finalResponse: JSON.stringify({
        prediction: envelope.candidates[0],
        modifier_present_probability: 0.75,
        probabilities: Object.fromEntries(envelope.candidates.map((candidate) => [candidate, probability])),
      }),
      usage: null,
    };
  }
  return {
    threadId: randomUUID(),
    finalResponse: JSON.stringify({ scores: Object.fromEntries(envelope.dimensions.map((dimension) => [dimension.key, 4])) }),
    usage: null,
  };
}

async function main() {
  const envelope = workerEnvelopeSchema.parse(JSON.parse(await readStandardInput()));
  if (process.env.WORDS_FAKE_CODEX === "1") {
    process.stdout.write(JSON.stringify(await fakeCall(envelope)));
    return;
  }

  const codex = new Codex({
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    config: {
      mcp_servers: {},
    },
  });
  const thread = codex.startThread({
    model: envelope.settings.model,
    modelReasoningEffort: envelope.settings.reasoningEffort,
    sandboxMode: process.env.WORDS_EXTERNAL_SANDBOX === "1" ? "danger-full-access" : "workspace-write",
    workingDirectory: process.cwd(),
    skipGitRepoCheck: true,
    networkAccessEnabled: process.env.WORDS_EXTERNAL_SANDBOX === "1" ? true : false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
    additionalDirectories: [],
    threadSource: "words-of-meaning-isolated-run",
  });
  const result = await thread.run(modelPrompt(envelope), { outputSchema: outputSchema(envelope) });
  if (!thread.id) throw new Error("Codex did not return a thread ID");
  if (envelope.kind === "generate") {
    const parsed = JSON.parse(result.finalResponse) as { files?: Array<{ path?: unknown; content?: unknown }> };
    if (!Array.isArray(parsed.files) || parsed.files.length === 0 || parsed.files.length > 20) throw new Error("Generation returned an invalid file list");
    const seen = new Set<string>();
    for (const file of parsed.files) {
      if (typeof file.path !== "string" || typeof file.content !== "string") throw new Error("Generation returned an invalid file entry");
      const normalized = path.posix.normalize(file.path.replaceAll("\\", "/"));
      if (normalized.startsWith("../") || normalized.startsWith("/") || normalized === "." || normalized.includes("/../") || path.isAbsolute(normalized)) throw new Error("Generation returned an unsafe file path");
      if (seen.has(normalized)) throw new Error("Generation returned a duplicate file path");
      seen.add(normalized);
      const destination = path.join(process.cwd(), normalized);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content, "utf8");
    }
  }
  process.stdout.write(JSON.stringify({
    threadId: thread.id,
    finalResponse: result.finalResponse,
    usage: result.usage,
  }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown worker error";
  process.stderr.write(message.replace(/[\r\n]+/g, " ").slice(0, 2_000));
  process.exitCode = 1;
});
