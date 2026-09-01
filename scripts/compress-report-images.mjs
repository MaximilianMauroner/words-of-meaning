import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const reportPath = path.resolve(process.argv[2] || ".agent/artifacts/words-of-meaning-report.html");
const html = await readFile(reportPath, "utf8");
const urls = [...new Set(html.match(/data:image\/jpeg;base64,[^"]+/g) || [])];
const temporary = await mkdtemp(path.join(os.tmpdir(), "words-report-images-"));
const replacements = new Map();

try {
  for (const [index, url] of urls.entries()) {
    const input = path.join(temporary, `${index}-input.jpg`);
    const output = path.join(temporary, `${index}-output.jpg`);
    await writeFile(input, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
    const result = spawnSync("ffmpeg", [
      "-loglevel", "error", "-y", "-i", input,
      "-vf", "scale=480:-2", "-q:v", "10", output,
    ]);
    if (result.status !== 0) throw new Error(result.stderr.toString("utf8") || "ffmpeg failed");
    const compressed = await readFile(output);
    replacements.set(url, `data:image/jpeg;base64,${compressed.toString("base64")}`);
  }
  const compressedHtml = [...replacements].reduce(
    (value, [before, after]) => value.replaceAll(before, after),
    html,
  );
  await writeFile(reportPath, compressedHtml);
  console.log(JSON.stringify({ images: urls.length, before: Buffer.byteLength(html), after: Buffer.byteLength(compressedHtml) }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
