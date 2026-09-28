import { describe, expect, test } from "bun:test";
import { recordShown, shouldShowPopup, SECOND_AFTER_MS, type PopupState } from "./approvals-popup";

const SIGN_IN = 1_000;
const at = (h: number, m = 0) => new Date(2026, 8, 28, h, m);
const HOUR = 60 * 60 * 1000;

describe("the approvals pop-up", () => {
  test("shows right after signing in", () => {
    expect(shouldShowPopup(null, at(9), SIGN_IN)).toBe(true);
  });

  test("not again straight away", () => {
    const s = recordShown(null, at(9), SIGN_IN);
    expect(shouldShowPopup(s, at(9, 5), SIGN_IN)).toBe(false);
    expect(shouldShowPopup(s, new Date(at(9).getTime() + SECOND_AFTER_MS - 1), SIGN_IN)).toBe(false);
  });

  test("a second time later that day, and no third", () => {
    let s: PopupState = recordShown(null, at(9), SIGN_IN);
    expect(shouldShowPopup(s, at(13), SIGN_IN)).toBe(true);
    s = recordShown(s, at(13), SIGN_IN);
    expect(s.shown).toBe(2);
    expect(shouldShowPopup(s, at(18), SIGN_IN)).toBe(false);
    expect(shouldShowPopup(s, at(23, 59), SIGN_IN)).toBe(false);
  });

  test("signing in again starts over", () => {
    let s: PopupState = recordShown(null, at(9), SIGN_IN);
    s = recordShown(s, at(14), SIGN_IN);
    expect(shouldShowPopup(s, at(15), SIGN_IN)).toBe(false);
    expect(shouldShowPopup(s, at(15), SIGN_IN + HOUR)).toBe(true);
    s = recordShown(s, at(15), SIGN_IN + HOUR);
    expect(s.shown).toBe(1);
  });

  test("a new day starts over, even in the same session", () => {
    let s: PopupState = recordShown(null, at(9), SIGN_IN);
    s = recordShown(s, at(14), SIGN_IN);
    expect(shouldShowPopup(s, new Date(2026, 8, 29, 8), SIGN_IN)).toBe(true);
  });
});
