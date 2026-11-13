import { describe, expect, it } from "vitest";
import {
  executionFallbackSelectionSchema,
  executionPolicySchema,
  fallbackSelectionsEqual,
  findDuplicateFallback,
  normalizeExecutionPolicy,
} from "./execution-policy";

describe("execution policy schema", () => {
  it("accepts a minimal valid policy", () => {
    const parsed = executionPolicySchema.parse({
      noAdditionalCost: true,
      fallbacks: [{ provider: "pi", model: "qwen3" }],
    });
    expect(parsed.noAdditionalCost).toBe(true);
    expect(parsed.fallbacks).toHaveLength(1);
    expect(parsed.fallbacks[0]!.provider).toBe("pi");
    expect(parsed.fallbacks[0]!.model).toBe("qwen3");
  });

  it("accepts reasoningLevel and serviceTier on fallbacks", () => {
    const parsed = executionPolicySchema.parse({
      noAdditionalCost: true,
      fallbacks: [
        { provider: "codex", model: "gpt-5", reasoningLevel: "medium", serviceTier: "fast" },
        { provider: "pi", model: "ollama-cloud/glm-5.3", reasoningLevel: "high" },
      ],
    });
    expect(parsed.fallbacks[0]!.serviceTier).toBe("fast");
    expect(parsed.fallbacks[1]!.reasoningLevel).toBe("high");
  });

  it("rejects noAdditionalCost: false", () => {
    expect(() =>
      executionPolicySchema.parse({
        noAdditionalCost: false,
        fallbacks: [{ provider: "pi", model: "qwen3" }],
      }),
    ).toThrow();
  });

  it("rejects an empty fallback list", () => {
    expect(() =>
      executionPolicySchema.parse({
        noAdditionalCost: true,
        fallbacks: [],
      }),
    ).toThrow();
  });

  it("rejects a fallback with empty provider or model", () => {
    expect(() =>
      executionFallbackSelectionSchema.parse({ provider: "", model: "x" }),
    ).toThrow();
    expect(() =>
      executionFallbackSelectionSchema.parse({ provider: "x", model: "  " }),
    ).toThrow();
  });

  it("preserves unknown reasoning and service tier values", () => {
    const parsed = executionPolicySchema.parse({
      noAdditionalCost: true,
      fallbacks: [{ provider: "old", model: "old-model", reasoningLevel: "unknown-tier", serviceTier: "custom" }],
    });
    expect(parsed.fallbacks[0]!.reasoningLevel).toBe("unknown-tier");
    expect(parsed.fallbacks[0]!.serviceTier).toBe("custom");
  });
});

describe("execution policy helpers", () => {
  it("normalizes undefined and empty policies to undefined", () => {
    expect(normalizeExecutionPolicy(undefined)).toBeUndefined();
    expect(
      normalizeExecutionPolicy({ noAdditionalCost: true, fallbacks: [] }),
    ).toBeUndefined();
  });

  it("keeps a policy with non-empty fallbacks", () => {
    const policy = { noAdditionalCost: true as const, fallbacks: [{ provider: "pi", model: "qwen3" }] };
    expect(normalizeExecutionPolicy(policy)).toEqual(policy);
  });

  it("detects equal selections by provider+model only", () => {
    const a = { provider: "pi", model: "qwen3", reasoningLevel: "low" };
    const b = { provider: "pi", model: "qwen3", reasoningLevel: "high" };
    expect(fallbackSelectionsEqual(a, b)).toBe(true);
    expect(fallbackSelectionsEqual(a, { provider: "codex", model: "qwen3" })).toBe(false);
  });

  it("finds the first duplicate provider+model", () => {
    const list = [
      { provider: "pi", model: "qwen3" },
      { provider: "codex", model: "gpt-5" },
      { provider: "pi", model: "qwen3", reasoningLevel: "high" },
    ];
    const dup = findDuplicateFallback(list);
    expect(dup).toBeDefined();
    expect(dup!.provider).toBe("pi");
    expect(dup!.model).toBe("qwen3");
  });

  it("returns undefined when there are no duplicates", () => {
    const list = [
      { provider: "pi", model: "qwen3" },
      { provider: "codex", model: "gpt-5" },
    ];
    expect(findDuplicateFallback(list)).toBeUndefined();
  });
});
