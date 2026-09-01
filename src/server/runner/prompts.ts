import type { WorkerEnvelope } from "@/shared/worker";

const sourceContract = `
Return the requested implementation through the required structured file response.
Each file needs a safe relative path and its complete UTF-8 content.
Do not use file-editing tools. Do not return prose outside the structured response.
Do not mention, quote, or encode the qualitative modifier from the task in source comments, names, documentation, or visible copy.
Do not read outside the current working directory.
Do not use the network.
Do not create dependency folders or build output.
Return only files needed for the requested artifact.
`.trim();

const plainHtmlContract = `
Return a static browser-ready design using only plain HTML and CSS.
Create exactly these two files: index.html and styles.css.
Do not use React, JSX, TypeScript, JavaScript, inline event handlers, external assets, or external dependencies.
Link styles.css from index.html. Keep all visible text and layout in those files.
`.trim();

export function modelPrompt(envelope: WorkerEnvelope): string {
  if (envelope.kind === "generate") {
    const formatContract = envelope.artifactFormat === "plain_html_css" ? plainHtmlContract : sourceContract;
    return `${envelope.prompt}\n\nArtifact contract:\n${formatContract}`;
  }
  if (envelope.kind === "classify") {
    return [
      "You are a blind classifier. Infer which candidate most likely caused the observable source-code behavior.",
      "Make two judgments independently. First estimate whether any qualitative modifier was present. Then identify the exact modifier among the adjective candidates, conditional on a modifier being present.",
      "The probability map is only the adjective-identification comparison and must not be derived mechanically from the modifier-presence estimate.",
      "Do not explain your answer. Return only the required JSON object.",
      `Task without modifier:\n${envelope.neutralTask}`,
      `Candidates in randomized order:\n${envelope.candidates.join("\n")}`,
      `Generated source bundle:\n${envelope.sourceBundle}`,
    ].join("\n\n");
  }
  const rubric = envelope.dimensions.map((dimension) => [
    `${dimension.key} (${dimension.label})`,
    `1: ${dimension.low}`,
    `4: ${dimension.mid}`,
    `7: ${dimension.high}`,
  ].join("\n")).join("\n\n");
  return [
    "Score only observable properties of the source bundle.",
    "Do not infer or name the hidden modifier. Do not explain your scores.",
    "Use an integer from 1 to 7. Use null only when the source provides no evidence.",
    `Task without modifier:\n${envelope.neutralTask}`,
    `Rubric:\n${rubric}`,
    `Generated source bundle:\n${envelope.sourceBundle}`,
  ].join("\n\n");
}

export function outputSchema(envelope: WorkerEnvelope): unknown | undefined {
  if (envelope.kind === "generate") return {
    type: "object",
    additionalProperties: false,
    required: ["files"],
    properties: {
      files: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "content"],
          properties: {
            path: { type: "string", minLength: 1, maxLength: 240 },
            content: { type: "string", maxLength: 200000 },
          },
        },
      },
    },
  };
  if (envelope.kind === "classify") {
    const probabilityProperties = Object.fromEntries(envelope.candidates.map((candidate) => [
      candidate,
      { type: "number", minimum: 0, maximum: 1 },
    ]));
    return {
      type: "object",
      additionalProperties: false,
      required: ["prediction", "modifier_present_probability", "probabilities"],
      properties: {
        prediction: { type: "string", enum: envelope.candidates },
        modifier_present_probability: { type: "number", minimum: 0, maximum: 1 },
        probabilities: {
          type: "object",
          additionalProperties: false,
          required: envelope.candidates,
          properties: probabilityProperties,
        },
      },
    };
  }
  const scoreProperties = Object.fromEntries(envelope.dimensions.map((dimension) => [
    dimension.key,
    { anyOf: [{ type: "integer", minimum: 1, maximum: 7 }, { type: "null" }] },
  ]));
  return {
    type: "object",
    additionalProperties: false,
    required: ["scores"],
    properties: {
      scores: {
        type: "object",
        additionalProperties: false,
        required: envelope.dimensions.map((dimension) => dimension.key),
        properties: scoreProperties,
      },
    },
  };
}
