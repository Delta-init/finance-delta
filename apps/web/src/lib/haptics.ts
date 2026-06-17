function vibrate(pattern: number | number[]) {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    try {
      navigator.vibrate(pattern);
    } catch {
      // silently ignore — not all browsers support this
    }
  }
}

export const haptics = {
  tap: () => vibrate(10),
  success: () => vibrate([10, 30, 10]),
  error: () => vibrate([30, 20, 30]),
  warning: () => vibrate([20, 10, 20]),
  info: () => vibrate(15),
};
