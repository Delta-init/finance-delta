"use client";

/**
 * Hand the browser a file it did not fetch.
 *
 * A BOM in front of the text, because Excel on Windows reads a CSV as the local
 * code page unless it sees one, and an Arabic customer name comes out as
 * mojibake. Every other reader ignores it.
 *
 * The object URL is revoked once the click has been dispatched; leaving it
 * holds the whole file in memory for the life of the tab.
 */
export function downloadTextFile(filename: string, text: string, mimeType = "text/csv;charset=utf-8"): void {
  const blob = new Blob(["﻿", text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
