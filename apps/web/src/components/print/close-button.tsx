"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Leaving a print page, whichever way you arrived at it.
 *
 * These pages had a Close button that called `window.close()`, which a browser
 * only honours for a tab that script opened. A receipt is reached with
 * `router.push` in the tab you were already in, so the button did nothing at
 * all — no error, no movement, just a dead control.
 *
 * So it closes the tab only when it is genuinely a tab this application
 * opened, and otherwise goes back to where you came from. The label follows,
 * because "Close" on something that will not close is the original bug wearing
 * a different hat.
 *
 * `window.opener` is the test rather than `history.length`: a scripted tab has
 * one, a normal navigation does not, and a page opened in a fresh tab by hand
 * correctly falls back to the record it belongs to.
 */
export function PrintCloseButton({
  fallbackHref,
  style,
}: {
  /** Where "back" goes when there is no history to go back to. */
  fallbackHref: string;
  style?: React.CSSProperties;
}) {
  const router = useRouter();
  // Read on the client only: the server has no opener to ask about, and
  // guessing produces a button whose label changes after hydration.
  const [openedByScript, setOpenedByScript] = useState<boolean | null>(null);

  useEffect(() => {
    setOpenedByScript(Boolean(window.opener) && !window.opener?.closed);
  }, []);

  function leave() {
    if (openedByScript) {
      window.close();
      // A refused close is silent, so do not leave somebody staring at a page
      // that did not go away.
      setTimeout(() => { if (!window.closed) router.push(fallbackHref); }, 150);
      return;
    }
    if (window.history.length > 1) router.back();
    else router.push(fallbackHref);
  }

  return (
    <button
      onClick={leave}
      style={{
        padding: "8px 16px",
        background: "#f1f5f9",
        color: "#111",
        border: "none",
        borderRadius: 6,
        cursor: "pointer",
        fontSize: 13,
        ...style,
      }}
    >
      {openedByScript ? "Close" : "Back"}
    </button>
  );
}
