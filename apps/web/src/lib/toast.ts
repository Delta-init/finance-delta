/**
 * App-wide toast — wraps gooeyToast + fires Web Haptics on each call.
 * Import from here instead of "sonner" or "goey-toast" directly.
 */
import { gooeyToast } from "goey-toast";
import type { GooeyToastOptions } from "goey-toast";
import { haptics } from "./haptics";

const toast = Object.assign(
  (message: string, options?: GooeyToastOptions) => {
    haptics.tap();
    return gooeyToast(message, options);
  },
  {
    success: (message: string, options?: GooeyToastOptions) => {
      haptics.success();
      return gooeyToast.success(message, options);
    },
    error: (message: string, options?: GooeyToastOptions) => {
      haptics.error();
      return gooeyToast.error(message, options);
    },
    warning: (message: string, options?: GooeyToastOptions) => {
      haptics.warning();
      return gooeyToast.warning(message, options);
    },
    info: (message: string, options?: GooeyToastOptions) => {
      haptics.info();
      return gooeyToast.info(message, options);
    },
    promise: gooeyToast.promise.bind(gooeyToast),
    dismiss: gooeyToast.dismiss.bind(gooeyToast),
    update: gooeyToast.update.bind(gooeyToast),
  },
);

export { toast };
export type { GooeyToastOptions as ToastOptions };
