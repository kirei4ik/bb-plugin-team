// Тесты settings-localization: локализованные дескрипторы, выбор языка при
// загрузке, контракт generatorSelection и сообщения об ошибках.

import { describe, expect, it } from "vitest";
import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import {
  GENERATOR_SELECTION_KV_KEY,
  SETTING_META,
  generalSettingDescriptors,
  generatorSelectionSchema,
  languageSettingDescriptor,
  parseGeneratorSelection,
  settingsMessages,
  stringsFor,
  type SettingKey,
} from "./settings-localization";

const KEYS: SettingKey[] = [
  "defaultTracker",
  "defaultTemplate",
  "language",
  "teamSection",
  "roster",
  "titleFormat",
];

const isDescriptor = (value: unknown): value is PluginSettingDescriptor => {
  const type = (value as { type?: string }).type;
  return ["string", "select", "boolean", "number", "project"].includes(String(type));
};

describe("SETTING_META", () => {
  it("каждый ключ настроек имеет непустые label в обоих языках", () => {
    expect(Object.keys(SETTING_META).sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) {
      for (const lang of ["en", "ru"] as const) {
        expect(stringsFor(key, lang).label.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("en и ru подписи реально различаются (кроме переключателя language)", () => {
    for (const key of KEYS) {
      const { en, ru } = SETTING_META[key];
      if (key === "language") {
        // Переключатель обязан быть находимым на обоих языках.
        expect(en.label).toBe(ru.label);
        continue;
      }
      expect(en.label).not.toBe(ru.label);
    }
  });

  it("optionLabels покрывают только значения своего select", () => {
    const tracker = SETTING_META.defaultTracker;
    for (const lang of ["en", "ru"] as const) {
      expect(Object.keys(tracker[lang].optionLabels ?? {}).sort()).toEqual(["beads", "builtin"]);
    }
  });
});

describe("languageSettingDescriptor (фаза 1)", () => {
  it("дескриптор валиден, options en/ru, default en", () => {
    const descriptor = languageSettingDescriptor();
    expect(isDescriptor(descriptor)).toBe(true);
    expect(descriptor).toMatchObject({
      type: "select",
      options: ["en", "ru"],
      default: "en",
      // Переключатель языка обязан быть находимым на обоих языках.
      label: "Language / Язык",
    });
  });
});

describe("generalSettingDescriptors (фаза 2)", () => {
  it("ru: одноязычные русские подписи, ключи и дефолты сохранены", () => {
    const descriptors = generalSettingDescriptors("ru");
    expect(Object.keys(descriptors).sort()).toEqual(
      ["defaultTracker", "defaultTemplate", "teamSection", "roster", "titleFormat"].sort(),
    );
    for (const descriptor of Object.values(descriptors)) {
      expect(isDescriptor(descriptor)).toBe(true);
    }
    expect(descriptors.defaultTracker.default).toBe("beads");
    expect(descriptors.defaultTemplate.default).toBe("dev");
    expect(descriptors.teamSection.default).toBe(true);
    expect(descriptors.roster.default).toBe(true);
    expect(descriptors.titleFormat.default).toBe("👥 {team} · {role}");
    // Русские подписи берутся из меты, без «EN / RU»-склейки.
    expect(descriptors.defaultTemplate.label).toBe(SETTING_META.defaultTemplate.ru.label);
    expect(descriptors.defaultTemplate.description).toBe(SETTING_META.defaultTemplate.ru.description);
    expect(descriptors.defaultTracker.experimental_optionLabels).toEqual({
      beads: "Beads (внешний трекер задач)",
      builtin: "Встроенные задачи",
    });
  });

  it("en: одноязычные английские подписи", () => {
    const descriptors = generalSettingDescriptors("en");
    expect(descriptors.defaultTemplate.label).toBe(SETTING_META.defaultTemplate.en.label);
    expect(descriptors.teamSection.label).toBe(SETTING_META.teamSection.en.label);
    expect(descriptors.defaultTracker.experimental_optionLabels).toEqual({
      beads: "Beads (issue tracker)",
      builtin: "Built-in tasks",
    });
  });
});

describe("generatorSelection", () => {
  it("принимает минимальную и полную форму", () => {
    expect(generatorSelectionSchema.parse({ providerId: "pi", model: "gpt-5" })).toEqual({
      providerId: "pi",
      model: "gpt-5",
    });
    expect(
      generatorSelectionSchema.parse({
        providerId: "pi",
        model: "gpt-5",
        reasoningLevel: "high",
        serviceTier: "priority",
      }),
    ).toEqual({ providerId: "pi", model: "gpt-5", reasoningLevel: "high", serviceTier: "priority" });
  });

  it("отвергает пустые поля, лишние ключи и неизвестные reasoningLevel", () => {
    expect(generatorSelectionSchema.safeParse({ providerId: "", model: "m" }).success).toBe(false);
    expect(generatorSelectionSchema.safeParse({ providerId: "pi" }).success).toBe(false);
    expect(
      generatorSelectionSchema.safeParse({ providerId: "pi", model: "m", extra: 1 }).success,
    ).toBe(false);
    expect(
      generatorSelectionSchema.safeParse({ providerId: "pi", model: "m", reasoningLevel: "ultra-max" })
        .success,
    ).toBe(false);
  });

  it("parseGeneratorSelection из kv: битое значение читается как null", () => {
    expect(parseGeneratorSelection(undefined)).toBeNull();
    expect(parseGeneratorSelection("nope")).toBeNull();
    expect(parseGeneratorSelection({ providerId: "pi", model: "" })).toBeNull();
    expect(parseGeneratorSelection({ providerId: "pi", model: "m" })).toEqual({
      providerId: "pi",
      model: "m",
    });
  });

  it("kv-ключ фиксирован одним именем", () => {
    expect(GENERATOR_SELECTION_KV_KEY).toBe("generatorSelection");
  });
});

describe("settingsMessages", () => {
  it("ru и en сообщения об отсутствии шаблона", () => {
    expect(settingsMessages("ru").defaultTemplateMissing("ghost")).toMatchObject({
      message: expect.stringContaining("ghost"),
      hint: expect.any(String),
    });
    expect(settingsMessages("en").defaultTemplateMissing("ghost").message).toContain("ghost");
  });

  it("templateIsDefault: отказ с подсказкой выбрать другой шаблон", () => {
    const ru = settingsMessages("ru").templateIsDefault("dev");
    expect(ru.message).toContain("dev");
    expect(ru.hint.length).toBeGreaterThan(0);
    const en = settingsMessages("en").templateIsDefault("dev");
    expect(en.message).toContain("dev");
  });

  it("reloadHint упоминет перезагрузку на обоих языках", () => {
    expect(settingsMessages("ru").reloadHint).toContain("reload");
    expect(settingsMessages("en").reloadHint).toContain("reload");
  });

  it("подписи полей генератора есть в обоих языках", () => {
    for (const lang of ["en", "ru"] as const) {
      const fields = settingsMessages(lang).generatorFields;
      for (const value of Object.values(fields)) {
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
