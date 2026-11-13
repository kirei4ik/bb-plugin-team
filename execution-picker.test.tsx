// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { fireEvent } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ExecutionModelPicker, resolveExecutionDraft, useProjectModelRouting } from "./execution-picker";

const catalog = (available = true, empty = false) => ({
  providers: [{ id: "pi", available }], modelLoadError: null,
  models: empty ? [] : [{ model: "ollama-cloud/kimi-k2.7-code", id: "ollama-cloud/kimi-k2.7-code", isDefault: true,
    supportedReasoningEfforts:[{reasoningEffort:"medium",description:""}], defaultReasoningEffort: "medium", routeProviderId: "ollama-cloud", supportedServiceTiers: [{ id: "fast" }] }],
});

describe("picker catalog adapter", () => {
  it("Pi upstream route is not a BB provider ID; defaults stay local until a selection", async () => {
    const models = vi.fn(async (_args?: unknown) => catalog());
    const sdk = { providers: { models } } as unknown as PluginBrowserBbSdk;
    const stored = Object.freeze({ providerId: "pi" });
    const draft = await resolveExecutionDraft(sdk, stored, { kind: "host", hostId: "remote" });
    expect(draft).toEqual({ providerId: "pi", model: "ollama-cloud/kimi-k2.7-code", reasoningLevel: "medium" });
    expect(models.mock.calls[0]?.[0]).toMatchObject({ providerId: "pi", hostId: "remote" });
    expect(stored).toEqual({ providerId: "pi" });
    expect(draft.serviceTier).toBeUndefined();
  });
  it("does not replace a stored unavailable provider/model with an unrelated default", async () => {
    const sdk = { providers: { models: async () => catalog(false) } } as unknown as PluginBrowserBbSdk;
    await expect(resolveExecutionDraft(sdk, { providerId: "pi" }, undefined)).rejects.toThrow("Provider unavailable");
    const sdk2 = { providers: { models: async () => catalog() } } as unknown as PluginBrowserBbSdk;
    await expect(resolveExecutionDraft(sdk2, { providerId: "pi", model: "removed" }, undefined)).rejects.toThrow("Model unavailable");
    const sdk3 = { providers: { models: async () => catalog(true, true) } } as unknown as PluginBrowserBbSdk;
    await expect(resolveExecutionDraft(sdk3, { providerId: "pi" }, undefined)).rejects.toThrow("empty");
  });
  it("hides the old project's picker while the new route is loading or failed", async () => {
    let rejectRoute!: (cause: Error) => void;
    const onChange = vi.fn();
    function Panel() {
      const [project, setProject] = useState("first");
      const routing = useProjectModelRouting(project);
      return <><button onClick={() => setProject("second")}>Next project</button><output>{routing.status}</output>
        <ExecutionModelPicker routing={routing} value={{providerId:"pi",model:"ollama-cloud/kimi-k2.7-code",reasoningLevel:"medium"}}
          onChange={onChange} defaultLabel="Default" selectLabel="Select" useDefaultLabel="Use default" /></>;
    }
    const app = await loadPluginApp(async () => ({ default: definePluginApp(app => {
      app.slots.navPanel({ id: "picker-test", path: "picker-test", title: "Picker", icon: "users", component: Panel });
    }) }));
    const slot = renderSlot(app.navPanels[0]!, { subPath:"" }, { sdk: {
      providers: { models: async () => catalog() as never },
      environments: { list: async ({projectId}: {projectId?:string}) => projectId === "first"
        ? [{id:"env_first",projectId:"first",status:"ready"}]
        : new Promise((_, reject) => { rejectRoute = reject; }) },
    } });
    try {
      await slot.findByLabelText("Provider ID");
      fireEvent.click(slot.getByText("Next project"));
      expect(slot.queryByLabelText("Provider ID")).toBeNull();
      rejectRoute(new Error("Remote host offline"));
      await slot.findByText(/Remote host offline/);
      expect(slot.queryByLabelText("Provider ID")).toBeNull();
      expect(onChange).not.toHaveBeenCalled();
    } finally { slot.lifecycle.unmount(); }
  });
});


it("never mounts the native picker with an unavailable complete saved selection", async () => {
  const onChange = vi.fn();
  function Panel() {
    return <ExecutionModelPicker value={{providerId:"pi", model:"acceptance-unavailable-model", reasoningLevel:"medium"}}
      onChange={onChange} defaultLabel="Default" selectLabel="Select" useDefaultLabel="Use default" />;
  }
  const app = await loadPluginApp(async () => ({default: definePluginApp(app => {
    app.slots.navPanel({id:"unknown-model", path:"unknown-model", title:"Unknown model", icon:"users", component:Panel});
  })}));
  const slot = renderSlot(app.navPanels[0]!, {subPath:""}, {sdk:{providers:{models: async () => catalog() as never}}});
  try {
    await slot.findByText(/Model unavailable: acceptance-unavailable-model/);
    expect(slot.getByText("pi · acceptance-unavailable-model")).toBeTruthy();
    expect(slot.queryByLabelText("Provider ID")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  } finally {slot.lifecycle.unmount();}
});

it("preserves unsupported saved reasoning and tier instead of mounting a normalizing picker",async()=>{
 const sdk={providers:{models:async()=>catalog()}} as unknown as PluginBrowserBbSdk;
 const saved={providerId:"pi",model:"ollama-cloud/kimi-k2.7-code",reasoningLevel:"future-reasoning",serviceTier:"future-tier"};
 await expect(resolveExecutionDraft(sdk,saved,undefined)).rejects.toThrow("Reasoning unavailable");
 await expect(resolveExecutionDraft(sdk,{...saved,reasoningLevel:"medium"},undefined)).rejects.toThrow("Service tier unavailable");
 expect(saved.reasoningLevel).toBe("future-reasoning");expect(saved.serviceTier).toBe("future-tier");
});
