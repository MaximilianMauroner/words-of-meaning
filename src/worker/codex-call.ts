import { Codex } from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
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
        modifier_present_probability: envelope.candidates[0] === "control" ? 0.25 : 0.75,
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
