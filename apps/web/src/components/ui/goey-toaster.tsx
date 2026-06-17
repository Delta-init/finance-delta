"use client";

import { GooeyToaster } from "goey-toast";
import "goey-toast/styles.css";
export function GoeyToaster() {
  return (
    <GooeyToaster
      position="bottom-center"
      preset="smooth"
      closeButton
      richColors
      maxQueue={1}
      // theme={(theme as "light" | "dark")=="light"?"dark":"light"}
      
    />
  );
}
