import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./core";
import { executorReviewPolicy, sessionHandoffPolicy } from "./messages";
import type { Language } from "./snapshot";

function fakeApi(): Parameters<typeof loadRolePrompt>[0] {
  return {} as never;
}

async function promptFor(
  lang: Language,
  role: { name: string; kind?: string; title?: string; lead?: boolean; prompt?: string; promptFile?: string },
  lead: boolean,
): Promise<string> {
  return loadRolePrompt(
    fakeApi(),
    {} as never,
    role as never,
    lead,
    lang,
    {} as never,
  );
}

describe("loadRolePrompt appends executor review policy for non-lead roles", () => {
  it("adds the review policy to a developer prompt in English", async () => {
    const prompt = await promptFor("en", { name: "developer", kind: "developer" }, false);
    expect(prompt).toContain("Team package review and acceptance:");
    expect(prompt).toContain(executorReviewPolicy("en"));
  });

  it("adds the review policy to a Russian executor prompt", async () => {
    const prompt = await promptFor("ru", { name: "tester", kind: "tester" }, false);
    expect(prompt).toContain("Отчёт и приёмка пакета Team:");
    expect(prompt).toContain(executorReviewPolicy("ru"));
  });

  it("does not duplicate the review policy when the prompt already contains the marker", async () => {
    const marker = executorReviewPolicy("en");
    const prompt = await promptFor("en", { name: "developer", prompt: `Custom prompt.\n\n${marker}` }, false);
    const first = prompt.indexOf("Team package review and acceptance:");
    const last = prompt.lastIndexOf("Team package review and acceptance:");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBe(last);
  });

  it("does not add the review policy to the lead role", async () => {
    const prompt = await promptFor("en", { name: "lead", kind: "lead", lead: true }, true);
    expect(prompt).not.toContain("Team package review and acceptance:");
    expect(prompt).toContain("Autonomous lead operating rules");
  });

  it("still appends the session handoff policy", async () => {
    const prompt = await promptFor("en", { name: "developer", kind: "developer" }, false);
    expect(prompt).toContain(sessionHandoffPolicy("en"));
  });
});
