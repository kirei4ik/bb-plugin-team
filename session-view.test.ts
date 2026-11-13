import { describe, expect, it } from "vitest";
import { contextView } from "./session-view";

describe("контекст для карточки сессии", () => {
  it("различает точный и приблизительный счётчик без изменения чисел", () => {
    for (const estimated of [false, true]) {
      expect(contextView({estimated, usedTokens: 80000, modelContextWindow: 100000})).toEqual({
        kind: estimated ? "estimated" : "exact", usedTokens: 80000, limitTokens: 100000,
      });
    }
  });
  it("не представляет недоступные, бесконечные и противоречивые данные как заполнение", () => {
    for (const value of [null, {}, {estimated: false, usedTokens: Infinity, modelContextWindow: 100},
      {estimated: false, usedTokens: -1, modelContextWindow: 100},
      {estimated: false, usedTokens: 10, modelContextWindow: 0},
      {estimated: false, usedTokens: 10, modelContextWindow: 100, snapshot: {estimated: false, usedTokens: 11, contextWindowTokens: 100}},
      {estimated: false, usedTokens: 10, modelContextWindow: 100, snapshot: {estimated: true, usedTokens: 10, contextWindowTokens: 100}},
    ]) expect(contextView(value)).toEqual({kind: "unavailable", usedTokens: null, limitTokens: null});
  });
});
