// Settings localization: the single ru/en source for the Team plugin's
// general settings. Native descriptor labels are chosen ONCE at factory load
// from the stored language value, because the SDK has no runtime metadata
// update (re-define throws "already defined") and no pre-define read API
// (`bb.sdk.plugins.getSettings` 404s until the factory has run). The plugin
// therefore defines `language` first, reads it, and then registers the other
// descriptors with RU-only or EN-only texts. Switching the language refreshes
// the native page labels only after `bb plugin reload team` (documented
// limitation; the editor UI localizes immediately via the same module).

import { z } from "zod";
import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { DEFAULT_TITLE_FORMAT } from "./templates";
import type { Language } from "./snapshot";

export type SettingKey =
  | "defaultTracker"
  | "defaultTemplate"
  | "language"
  | "teamSection"
  | "roster"
  | "titleFormat";

export interface SettingStrings {
  label: string;
  description?: string;
  /** Display labels keyed by option value. */
  optionLabels?: Record<string, string>;
}

export interface SettingMetaEntry {
  en: SettingStrings;
  ru: SettingStrings;
}

/** Per-setting localized texts. Keys and option values stay language-neutral. */
export const SETTING_META: Record<SettingKey, SettingMetaEntry> = {
  defaultTracker: {
    en: {
      label: "Default task tracker",
      description:
        "Project override takes precedence. Beads errors never fall back to built-in.",
      optionLabels: { beads: "Beads (issue tracker)", builtin: "Built-in tasks" },
    },
    ru: {
      label: "Трекер задач по умолчанию",
      description:
        "Настройка проекта имеет приоритет. Если Beads недоступен, показывается ошибка.",
      optionLabels: { beads: "Beads (внешний трекер задач)", builtin: "Встроенные задачи" },
    },
  },
  defaultTemplate: {
    en: {
      label: "Default team template",
      description:
        "Team template for bb team init without --template. Pick from Settings → Team; a missing template is an explicit error, not a silent fallback.",
    },
    ru: {
      label: "Шаблон команды по умолчанию",
      description:
        "Шаблон для bb team init без --template. Выбирается в Настройки → Team; отсутствующий шаблон — явная ошибка, не скрытая подмена.",
    },
  },
  language: {
    en: {
      label: "Language / Язык",
      description: "CLI output, panel and template language: en (English) or ru (Русский)",
    },
    ru: {
      label: "Language / Язык",
      description: "Язык CLI, панели и шаблонов: en (English) или ru (Русский)",
    },
  },
  teamSection: {
    en: {
      label: "Team sidebar sections",
      description: "Keep each team's threads in its own sidebar section (Team · <name>)",
    },
    ru: {
      label: "Разделы команд в боковой панели",
      description: "Показывать треды каждой команды в отдельном разделе (Team · <имя>)",
    },
  },
  roster: {
    en: {
      label: "Send team roster",
      description: "Send the team roster message to the lead after bb team create",
    },
    ru: {
      label: "Отправлять состав команды",
      description: "Отправлять список ролей руководителю после bb team create",
    },
  },
  titleFormat: {
    en: {
      label: "Thread title format",
      description:
        "Title of team threads: {team} and {role} placeholders; {team} is dropped while the project has one team",
    },
    ru: {
      label: "Формат заголовка треда",
      description:
        "Заголовок тредов команды: плейсхолдеры {team} и {role}; {team} опускается, пока в проекте одна команда",
    },
  },
};

/** Localized texts of one setting in one language. */
export function stringsFor(key: SettingKey, lang: Language): SettingStrings {
  return SETTING_META[key][lang];
}

/**
 * Phase 1: the language switch itself, defined before its stored value can be
 * read — its label stays bilingual so both audiences can find the switch.
 */
export function languageSettingDescriptor(): PluginSettingDescriptor {
  const en = stringsFor("language", "en");
  const ru = stringsFor("language", "ru");
  return {
    type: "select",
    options: ["en", "ru"],
    default: "en",
    label: "Language / Язык",
    description: [
      en.description,
      ru.description,
      "Reload the Team plugin after changing the language to refresh these labels.",
      "После смены языка перезагрузите плагин Team, чтобы обновить подписи настроек.",
    ].filter(Boolean).join(" / "),
    experimental_optionLabels: { en: "English", ru: "Русский" },
  };
}

/**
 * Phase 2: every general setting except `language`, with RU-only or EN-only
 * labels/descriptions/optionLabels taken from the stored language value.
 */
export function generalSettingDescriptors(
  lang: Language,
): Record<string, PluginSettingDescriptor> {
  const at = (key: SettingKey): SettingStrings => stringsFor(key, lang);
  return {
    defaultTracker: {
      type: "select",
      options: ["beads", "builtin"],
      default: "beads",
      label: at("defaultTracker").label,
      description: at("defaultTracker").description,
      ...(at("defaultTracker").optionLabels
        ? { experimental_optionLabels: at("defaultTracker").optionLabels }
        : {}),
    },
    defaultTemplate: {
      type: "string",
      default: "dev",
      label: at("defaultTemplate").label,
      description: at("defaultTemplate").description,
    },
    teamSection: {
      type: "boolean",
      default: true,
      label: at("teamSection").label,
      description: at("teamSection").description,
    },
    roster: {
      type: "boolean",
      default: true,
      label: at("roster").label,
      description: at("roster").description,
    },
    titleFormat: {
      type: "string",
      default: DEFAULT_TITLE_FORMAT,
      label: at("titleFormat").label,
      description: at("titleFormat").description,
    },
  };
}

/* ── Generator selection: a standalone editor setting (one kv key) ── */

/** The single kv key storing the generator selection (not a native setting). */
export const GENERATOR_SELECTION_KV_KEY = "generatorSelection";

export const GENERATOR_REASONING_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "none",
  "ultra",
  "ultracode",
] as const;

export const generatorSelectionSchema = z
  .object({
    providerId: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(200),
    reasoningLevel: z.enum(GENERATOR_REASONING_LEVELS).optional(),
    serviceTier: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export type GeneratorSelection = z.infer<typeof generatorSelectionSchema>;

/** Parse a value read from kv storage; anything invalid reads as "not set". */
export function parseGeneratorSelection(raw: unknown): GeneratorSelection | null {
  const parsed = generatorSelectionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Editor-UI strings for the generator-selection fields (not a native setting). */
export const GENERATOR_SELECTION_META: Record<"generatorSelection", Record<Language, SettingStrings>> = {
  generatorSelection: {
    en: {
      label: "Prompt draft model",
      description:
        "Provider and model for AI prompt drafts. Stored separately from role models; picked per template role, no credentials are read here.",
    },
    ru: {
      label: "Модель черновиков промптов",
      description:
        "Провайдер и модель для ИИ-черновиков промптов. Хранится отдельно от моделей ролей; учётные данные здесь не читаются.",
    },
  },
};

/* ── Localized messages for settings behavior ── */

export interface SettingsMessages {
  /** defaultTemplate value does not exist in the current template list. */
  defaultTemplateMissing: (id: string) => { message: string; hint: string };
  /** Deleting the template that is currently the default is refused. */
  templateIsDefault: (id: string) => { message: string; hint: string };
  /** Saved confirmation for editorSettingsSet / editor UI. */
  saved: string;
  /** Hint shown after a language switch: native labels need a plugin reload. */
  reloadHint: string;
  /** generatorSelection field labels for the editor UI. */
  generatorFields: {
    providerId: string;
    model: string;
    reasoningLevel: string;
    serviceTier: string;
  };
}

const SETTINGS_MESSAGES: Record<Language, SettingsMessages> = {
  en: {
    defaultTemplateMissing: (id) => ({
      message: `Default team template "${id}" does not exist`,
      hint: "Pick an existing template (Settings → Team or bb team template list)",
    }),
    templateIsDefault: (id) => ({
      message: `Template "${id}" is the default team template and cannot be deleted`,
      hint: "Choose another default template first, then delete",
    }),
    saved: "Saved",
    reloadHint:
      "Team plugin settings on the Installed plugins page refresh after `bb plugin reload team`",
    generatorFields: {
      providerId: "Provider",
      model: "Model",
      reasoningLevel: "Reasoning level",
      serviceTier: "Service tier",
    },
  },
  ru: {
    defaultTemplateMissing: (id) => ({
      message: `Шаблона команды "${id}" не существует`,
      hint: "Выберите существующий шаблон (Настройки → Team или bb team template list)",
    }),
    templateIsDefault: (id) => ({
      message: `Шаблон "${id}" — шаблон команды по умолчанию, удалить нельзя`,
      hint: "Сначала выберите другой шаблон по умолчанию, затем удаляйте",
    }),
    saved: "Сохранено",
    reloadHint:
      "Подписи настроек на странице установленных плагинов обновятся только после перезагрузки плагина (`bb plugin reload team`)",
    generatorFields: {
      providerId: "Провайдер",
      model: "Модель",
      reasoningLevel: "Уровень рассуждений",
      serviceTier: "Сервисный уровень",
    },
  },
};

export function settingsMessages(lang: Language): SettingsMessages {
  return SETTINGS_MESSAGES[lang];
}
