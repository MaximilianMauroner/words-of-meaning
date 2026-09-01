import { createHmac } from "node:crypto";

function randomUnit(seed: string, scope: string, index: number): number {
  const digest = createHmac("sha256", seed).update(`${scope}:${index}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

export function seededShuffle<T>(values: readonly T[], seed: string, scope: string): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(randomUnit(seed, scope, index) * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}
