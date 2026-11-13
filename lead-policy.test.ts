import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { loadRolePrompt, type Role, type Workspace } from "./core";
import { leadAutonomyPolicy, sessionHandoffPolicy } from "./messages";
import type { Strings } from "./strings";

const workspace: Workspace = {
  projectId: "proj_1",
  projectName: "demo",
  path: "/ws/demo",
  hostId: "host_1",
};

const mockT = {
  promptFileMissing: (role: string, path: string) =>
    `missing prompt file for ${role}: ${path}`,
} as unknown as Strings;

function mockBb(files: Record<string, string> = {}): BbPluginApi {
  return {
    sdk: {
      files: {
        read: async ({ path }: { path: string }) => {
          const content = files[path];
          if (content === undefined) throw new Error(`ENOENT: ${path}`);
          return { content, sha256: "x" };
        },
      },
    },
  } as unknown as BbPluginApi;
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function policyMarker(lang: "en" | "ru"): string {
  return lang === "ru" ? "Правила автономного руководителя" : "Autonomous lead operating rules";
}

describe("loadRolePrompt lead policy (bbt-er6.2)", () => {
  it("custom executor preserves its text and receives the deferred handoff path once", async () => {
    const original = "  Custom executor.\n";
    const role = { name: "developer", prompt: original } as unknown as Role;
    const result = await loadRolePrompt(mockBb(), workspace, role, false, "en", mockT);
    expect(result.startsWith(original)).toBe(true);
    expect(result).toContain(sessionHandoffPolicy("en"));
    const repeated = await loadRolePrompt(mockBb(), workspace, { ...role, prompt: result }, false, "ru", mockT);
    expect(repeated).toBe(result);
    expect(occurrences(repeated, "Team session handoff:")).toBe(1);
  });
  it("appends the lead policy once to a custom inline lead prompt", async () => {
    const role = { name: "lead", kind: "lead", prompt: "You are my custom lead." } as unknown as Role;
    const result = await loadRolePrompt(mockBb(), workspace, role, true, "en", mockT);

    expect(result).toContain("You are my custom lead.");
    expect(result).toContain(leadAutonomyPolicy("en"));
    expect(occurrences(result, policyMarker("en"))).toBe(1);
  });

  it("appends the lead policy once to a custom file lead prompt", async () => {
    const role = {
      name: "lead",
      kind: "lead",
      promptFile: ".bb/teams/core/lead.md",
    } as unknown as Role;
    const bb = mockBb({ "/ws/demo/.bb/teams/core/lead.md": "Custom lead prompt from file." });
    const result = await loadRolePrompt(bb, workspace, role, true, "en", mockT);

    expect(result).toContain("Custom lead prompt from file.");
    expect(result).toContain(leadAutonomyPolicy("en"));
    expect(occurrences(result, policyMarker("en"))).toBe(1);
  });

  it("builtin lead prompt already contains the policy exactly once", async () => {
    const role = { name: "lead", kind: "lead" } as unknown as Role;
    const result = await loadRolePrompt(mockBb(), workspace, role, true, "en", mockT);

    expect(result).toContain(leadAutonomyPolicy("en"));
    expect(occurrences(result, policyMarker("en"))).toBe(1);
  });

  it("does not duplicate the lead policy when the custom prompt already has it", async () => {
    const role = {
      name: "lead",
      kind: "lead",
      prompt: `${leadAutonomyPolicy("en")}\n\nMy extra rules.`,
    } as unknown as Role;
    const result = await loadRolePrompt(mockBb(), workspace, role, true, "en", mockT);

    expect(result).toContain("My extra rules.");
    expect(occurrences(result, policyMarker("en"))).toBe(1);
  });

  it("non-lead roles do not receive the lead policy", async () => {
    const role = { name: "developer", kind: "developer" } as unknown as Role;
    const result = await loadRolePrompt(mockBb(), workspace, role, false, "en", mockT);

    expect(result).not.toContain(leadAutonomyPolicy("en"));
    expect(occurrences(result, policyMarker("en"))).toBe(0);
  });

  it("builtin lead prompt in Russian contains the policy exactly once", async () => {
    const role = { name: "lead", kind: "lead" } as unknown as Role;
    const result = await loadRolePrompt(mockBb(), workspace, role, true, "ru", mockT);

    expect(result).toContain(leadAutonomyPolicy("ru"));
    expect(occurrences(result, policyMarker("ru"))).toBe(1);
  });

  it("executor prompt instructs checkpoint before review", async () => {
    const role = { name: "developer", kind: "developer" } as unknown as Role;
    const result = await loadRolePrompt(mockBb(), workspace, role, false, "en", mockT);

    expect(result).toContain("bb team checkpoint");
    expect(result).toContain("goal, criteria[]");
    expect(result).toContain("decisions[{what,why}]");
    expect(result).toContain("Do not copy the last output");
    expect(result).toContain("--status review");
    // The policy belongs to the lead, not executors.
    expect(result).not.toContain(policyMarker("en"));
  });
});
