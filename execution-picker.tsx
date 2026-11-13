// Adapt optional role fields to BB's concrete picker value without saving defaults.
import { useEffect, useState } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker, useSdk } from "@get-bb/plugin-sdk/app";
import type { ExperimentalProviderModelPickerRouting, ExperimentalProviderModelPickerValue, PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

export interface ExecutionModel { providerId?: string; model?: string; reasoningLevel?: string; serviceTier?: string }
export interface ProjectModelRoutingState {
  routing: ExperimentalProviderModelPickerRouting | undefined;
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  retry: () => void;
}
export interface ExecutionModelPickerProps {
  value: ExecutionModel | undefined;
  onChange: (next: ExecutionModel | undefined) => void;
  routing?: ProjectModelRoutingState;
  disabled?: boolean;
  defaultLabel: string;
  selectLabel: string;
  useDefaultLabel: string;
  language?: "en" | "ru";
}

/** Models belong to the requested BB provider; routeProviderId names an upstream service. */
export async function resolveExecutionDraft(sdk: PluginBrowserBbSdk, value: ExecutionModel | undefined,
  routing: ExperimentalProviderModelPickerRouting | undefined, signal?: AbortSignal): Promise<ExperimentalProviderModelPickerValue> {
  const route = routing?.kind === "environment" ? { environmentId: routing.environmentId } : routing?.kind === "host" ? { hostId: routing.hostId } : {};
  const load = (providerId?: string) => sdk.providers.models({ ...route, ...(providerId ? { providerId } : {}), signal });
  let providerId = value?.providerId;
  let catalog = await load(providerId);
  if (!providerId) {
    providerId = catalog.providers.find(p => p.available)?.id;
    if (!providerId) throw new Error("No available provider");
    catalog = await load(providerId);
  }
  if (catalog.modelLoadError) throw new Error(catalog.modelLoadError.detail || "Model catalog unavailable");
  if (!catalog.providers.some(p => p.id === providerId && p.available)) throw new Error(`Provider unavailable: ${providerId}`);
  const model = value?.model
    ? catalog.models.find(m => m.model === value.model || m.id === value.model)
    : catalog.models.find(m => m.isDefault) ?? catalog.models[0];
  if (!model) throw new Error(value?.model ? `Model unavailable: ${value.model}` : "Model catalog is empty");
  // A native picker may normalize unsupported saved options on mount as well.
  // Keep their original values outside it until the user explicitly clears them.
  if (value?.reasoningLevel && !model.supportedReasoningEfforts.some(e => e.reasoningEffort === value.reasoningLevel)) {
    throw new Error(`Reasoning unavailable: ${value.reasoningLevel}`);
  }
  if (value?.serviceTier && !model.supportedServiceTiers?.some(tier => tier.id === value.serviceTier)) {
    throw new Error(`Service tier unavailable: ${value.serviceTier}`);
  }
  return { providerId, model: value?.model || model.model, reasoningLevel: value?.reasoningLevel || model.defaultReasoningEffort,
    ...(value?.serviceTier ? { serviceTier: value.serviceTier } : {}) };
}

type Draft = { key: string; value?: ExperimentalProviderModelPickerValue; error?: string };
export function ExecutionModelPicker({ value, onChange, routing, disabled, defaultLabel, selectLabel, useDefaultLabel, language = "en" }: ExecutionModelPickerProps) {
  const sdk = useSdk();
  const [open, setOpen] = useState(Boolean(value?.model));
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const route = routing?.routing;
  const routeKey = route ? `${route.kind}:${route.kind === "host" ? route.hostId : route.environmentId}` : "primary";
  const blocked = routing?.status === "loading" || routing?.status === "error";
  const key = JSON.stringify([value?.providerId, value?.model, value?.reasoningLevel, value?.serviceTier, routeKey, attempt]);
  const ru = language === "ru";
  useEffect(() => {
    if (!open || blocked || (disabled && !value?.model)) return;
    const controller = new AbortController();
    let active = true;
    void resolveExecutionDraft(sdk, value, route, controller.signal).then(
      selected => { if (active) setDraft({ key, value: selected }); },
      error => { if (active) setDraft({ key, error: String(error instanceof Error ? error.message : error) }); },
    );
    return () => { active = false; controller.abort(); };
    // Scalar key changes cancel stale catalog requests; draft loading never edits the role.
  }, [sdk, key, open, blocked, disabled]);
  // Native picker may normalize an unknown complete value and emit onChange on mount.
  // Validate every stored model against the catalog before rendering it.
  const selected = draft?.key === key ? draft.value : undefined;
  const error = routing?.status === "error" ? routing.error : draft?.key === key ? draft.error : undefined;
  const stored = [value?.providerId, value?.model || defaultLabel].filter(Boolean).join(" · ");
  const clear = () => { setOpen(false); setDraft(null); onChange(undefined); };
  return <div className="flex flex-col gap-1">
    {open && selected && !blocked ? <ProviderModelPicker value={selected} routing={route} disabled={disabled}
      onChange={next => onChange({ providerId: next.providerId, model: next.model, reasoningLevel: next.reasoningLevel,
        ...(next.serviceTier ? { serviceTier: next.serviceTier } : {}) })} /> : <>
      <span className="text-xs text-muted-foreground">{stored || defaultLabel}</span>
      {open && !disabled && !error && <span className="text-xs text-muted-foreground">{ru ? "Загрузка каталога…" : "Loading catalog…"}</span>}
      {!open && !disabled && <button type="button" disabled={blocked} onClick={() => setOpen(true)} className="text-xs text-foreground">{selectLabel}</button>}
    </>}
    {error && <span role="alert" className="text-xs text-destructive">{ru ? "Каталог недоступен" : "Catalog unavailable"}: {error}</span>}
    {error && !disabled && <button type="button" className="text-xs" onClick={() => { routing?.status === "error" ? routing.retry() : setAttempt(n => n + 1); }}>{ru ? "Повторить" : "Retry"}</button>}
    {!disabled && (open || value?.providerId || value?.model) && <button type="button" onClick={clear} className="self-start text-xs text-muted-foreground">{useDefaultLabel}</button>}
  </div>;
}

/** A project never silently falls back to the primary machine's catalog. */
export function useProjectModelRouting(projectId: string | null | undefined): ProjectModelRoutingState {
  const sdk = useSdk();
  const [attempt, setAttempt] = useState(0);
  const key = `${projectId ?? ""}:${attempt}`;
  const [state, setState] = useState<{ key: string; routing?: ExperimentalProviderModelPickerRouting; error?: string } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    void (async () => {
      try {
        const environments = await sdk.environments.list({ projectId });
        const ready = environments.find(e => e.status === "ready" && e.projectId === projectId);
        let route: ExperimentalProviderModelPickerRouting;
        if (ready) route = { kind: "environment", environmentId: ready.id };
        else {
          const project = await sdk.projects.get({ projectId });
          const source = project.sources.find(s => s.isDefault) ?? project.sources[0];
          if (!source?.hostId) throw new Error("Project has no source host");
          route = { kind: "host", hostId: source.hostId };
        }
        if (active) setState({ key, routing: route });
      } catch (error) { if (active) setState({ key, error: String(error instanceof Error ? error.message : error) }); }
    })();
    return () => { active = false; };
  }, [sdk, key, projectId]);
  const retry = () => setAttempt(n => n + 1);
  if (!projectId) return { status: "idle", routing: undefined, retry };
  if (!state || state.key !== key) return { status: "loading", routing: undefined, retry };
  return { status: state.error ? "error" : "ready", routing: state.routing, error: state.error, retry };
}
