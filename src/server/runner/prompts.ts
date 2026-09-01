import type { WorkerEnvelope } from "@/shared/worker";

const sourceContract = `
Create the requested implementation as source files in the current working directory.
You must use your file-editing tools to create the files. A prose answer or code block in the final response does not satisfy the task.
Before finishing, list the current directory and verify that the requested source files exist.
Do not mention, quote, or encode the qualitative modifier from the task in source comments, names, documentation, or visible copy.
Do not read outside the current working directory.
Do not use the network.
Do not create dependency folders or build output.
Finish after writing the source files. Keep the final response to one short sentence.
`.trim();

export function modelPrompt(envelope: WorkerEnvelope): string {
  if (envelope.kind === "generate") {
    return `${envelope.prompt}\n\nArtifact contract:\n${sourceContract}`;
  }
  if (envelope.kind === "classify") {
    return [
      "You are a blind classifier. Infer which candidate most likely caused the observable source-code behavior.",
      "Do not explain your answer. Return only the required JSON object.",
      "The control label means the task had no qualitative modifier.",
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
  if (envelope.kind === "generate") return undefined;
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
