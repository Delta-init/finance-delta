"use client";

import { useEffect, useState } from "react";

/**
 * True on a phone — narrower than the md breakpoint (768px) — where lists show as cards and the bottom dock is
 * (2026-11-17). Tablets keep the tables. False until mounted, like useIsMobile, so the server's render matches.
 */
export function useIsPhone() {
  const [isPhone, setIsPhone] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const onChange = () => setIsPhone(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isPhone;
}
