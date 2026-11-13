import { describe, expect, it } from "vitest";
import { parseTeamConfig, teamConfigSchema } from "./core";
import { strings } from "./strings";
import { teamFilesFromTemplate, templateRoleSchema } from "./templates";
import { load as loadYaml } from "js-yaml";

const t = strings("en");

describe("execution policy config round-trip", () => {
  it("parses a role with executionPolicy from YAML", () => {
    const yaml = `
version: 1
roles:
  - name: lead
    provider: codex
    model: gpt-5
    executionPolicy:
      noAdditionalCost: true
      fallbacks:
        - provider: pi
          model: qwen3
          reasoningLevel: high
        - provider: codex
          model: gpt-4
`;
    const config = parseTeamConfig(yaml, ".bb/teams/main.yaml", t);
    const lead = config.roles[0]!;
    expect(lead.executionPolicy).toBeDefined();
    expect(lead.executionPolicy!.noAdditionalCost).toBe(true);
    expect(lead.executionPolicy!.fallbacks).toHaveLength(2);
    expect(lead.executionPolicy!.fallbacks[0]!).toEqual({
      provider: "pi",
      model: "qwen3",
      reasoningLevel: "high",
    });
    expect(lead.executionPolicy!.fallbacks[1]!).toEqual({
      provider: "codex",
      model: "gpt-4",
    });
  });

  it("serializes executionPolicy when generating team files from a template", () => {
    const files = teamFilesFromTemplate(
      "en",
      {
        title: "Cloud team",
        roles: [
          {
            name: "lead",
            lead: true,
            provider: "codex",
            model: "gpt-5",
            executionPolicy: {
              noAdditionalCost: true,
              fallbacks: [
                { provider: "pi", model: "qwen3", reasoningLevel: "high", serviceTier: "fast" },
              ],
            },
          },
        ],
      },
      "main",
    );
    const configFile = files.find((f) => f.rel === ".bb/teams/main.yaml")!;
    const raw = loadYaml(configFile.content) as Record<string, unknown>;
    const roles = raw.roles as Array<Record<string, unknown>>;
    const policy = roles[0]!.executionPolicy as Record<string, unknown>;
    expect(policy.noAdditionalCost).toBe(true);
    const fallbacks = policy.fallbacks as Array<Record<string, unknown>>;
    expect(fallbacks[0]!).toEqual({
      provider: "pi",
      model: "qwen3",
      reasoningLevel: "high",
      serviceTier: "fast",
    });
  });

  it("preserves a config without executionPolicy unchanged", () => {
    const yaml = `
version: 1
roles:
  - name: lead
    provider: codex
`;
    const config = parseTeamConfig(yaml, ".bb/teams/main.yaml", t);
    expect(config.roles[0]!.executionPolicy).toBeUndefined();
  });

  it("templateRoleSchema accepts executionPolicy and preserves unknown reasoning", () => {
    const role = templateRoleSchema.parse({
      name: "lead",
      provider: "old",
      model: "old-model",
      reasoningLevel: "legacy",
      executionPolicy: {
        noAdditionalCost: true,
        fallbacks: [
          { provider: "old", model: "another", reasoningLevel: "legacy", serviceTier: "custom" },
        ],
      },
    });
    expect(role.executionPolicy!.fallbacks[0]!.reasoningLevel).toBe("legacy");
    expect(role.executionPolicy!.fallbacks[0]!.serviceTier).toBe("custom");
    expect(role.reasoningLevel).toBe("legacy");
  });

  it("schema rejects duplicate provider+model in a role executionPolicy", () => {
    const result = teamConfigSchema.safeParse({
      version: 1,
      roles: [
        {
          name: "lead",
          executionPolicy: {
            noAdditionalCost: true,
            fallbacks: [
              { provider: "pi", model: "qwen3" },
              { provider: "pi", model: "qwen3" },
            ],
          },
        },
      ],
    });
    // The same invariant holds at the raw config boundary.
    expect(result.success).toBe(false);
  });
});
