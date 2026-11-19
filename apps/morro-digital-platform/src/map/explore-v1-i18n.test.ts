import { describe, expect, it } from "vitest";
import {
  getAppliedMapFilterCopy,
  getV1ExploreLabel,
} from "./explore-v1-i18n.js";
describe("applied filter feedback", () => {
  it.each(["pt", "en", "es", "he"])(
    "distinguishes pending and unconfirmed in %s",
    (locale) => {
      const copy = getAppliedMapFilterCopy(locale);
      expect(copy.pending).not.toEqual(copy.error);
      expect(copy.clear.length).toBeGreaterThan(3);
      expect(copy.category).not.toEqual(copy.search);
    },
  );
  it("falls back to Portuguese for unknown locales", () => {
    expect(getAppliedMapFilterCopy("unknown")).toEqual(
      getAppliedMapFilterCopy("pt"),
    );
  });
  it.each([
    ["pt", "Conhecer este local"],
    ["en", "Learn about this place"],
    ["es", "Conocer este lugar"],
    ["he", "הכירו את המקום"],
  ] as const)("localizes the place-learning CTA in %s", (locale, label) => {
    expect(getV1ExploreLabel("learnPlace", locale)).toBe(label);
  });
});
