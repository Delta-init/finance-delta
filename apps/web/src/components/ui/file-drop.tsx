"use client";

import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * An upload area that also takes files dropped on it or pasted (the user,
 * 2026-10-21: "file upload we need paste option … and drag and drop").
 *
 * Wraps whatever the area already is — its own button and file input stay —
 * and hands dropped or pasted files to the same handler the input uses, so
 * the area's own checks (size, how many) still apply. Only the types its
 * `accept` names are taken, and one file where it takes one.
 *
 * Paste: Ctrl/Cmd+V with a file or a screenshot on the clipboard. It goes to
 * the area last pointed at or clicked, else the newest one on screen (an open
 * dialog's). A paste of text into a field is left alone.
 */

interface Zone {
  id: string;
  take: (files: File[]) => void;
  disabled: () => boolean;
  touchedAt: number;
  mountedAt: number;
}
const zones = new Map<string, Zone>();
let listening = false;

function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !["checkbox", "radio", "button", "submit", "file", "range", "color"].includes(el.type);
  return (el as HTMLElement).isContentEditable === true;
}

function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (!files.length) return;
  // Typing in a field and the clipboard has words too (a file copied from Finder carries its name): paste the words.
  if (isTextField(document.activeElement) && (e.clipboardData?.getData("text/plain") ?? "").trim()) return;
  const open = [...zones.values()].filter((z) => !z.disabled());
  if (!open.length) return;
  const zone = open.reduce((a, b) => (Math.max(b.touchedAt, b.mountedAt) > Math.max(a.touchedAt, a.mountedAt) ? b : a));
  e.preventDefault();
  zone.take(files);
}

/** Whether a file is one `accept` (an <input accept> string) lets in. */
export function accepts(file: File, accept?: string): boolean {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  return accept.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean).some((a) => {
    if (a.startsWith(".")) return name.endsWith(a);
    if (a.endsWith("/*")) return type.startsWith(a.slice(0, -1));
    return type === a;
  });
}

export interface FileDropOptions {
  /** Gets only files `accept` allows — one, unless `multiple`. */
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
}

/**
 * The same for an area that already exists: spread `zoneProps` on it (it needs
 * `relative`), and put `overlay` and `hint` inside it.
 */
export function useFileDrop({ onFiles, accept, multiple = false, disabled = false }: FileDropOptions) {
  const id = useId();
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const depth = useRef(0);
  const latest = useRef({ onFiles, accept, multiple, disabled });
  latest.current = { onFiles, accept, multiple, disabled };

  const take = (files: File[]) => {
    const { onFiles: give, accept: acc, multiple: many } = latest.current;
    const ok = files.filter((f) => accepts(f, acc));
    const left = files.length - ok.length;
    setRefused(left ? `${left === 1 ? "A file" : `${left} files`} of a kind this does not take ${left === 1 ? "was" : "were"} left out.` : null);
    if (ok.length) give(many ? ok : ok.slice(0, 1));
  };

  useEffect(() => {
    zones.set(id, { id, take, disabled: () => latest.current.disabled, touchedAt: 0, mountedAt: Date.now() });
    if (!listening) {
      document.addEventListener("paste", onPaste);
      listening = true;
    }
    return () => {
      zones.delete(id);
      if (!zones.size && listening) {
        document.removeEventListener("paste", onPaste);
        listening = false;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const touch = () => { const z = zones.get(id); if (z) z.touchedAt = Date.now(); };
  const hasFiles = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const zoneProps = {
    onPointerEnter: touch,
    onPointerDown: touch,
    onFocusCapture: touch,
    onDragEnter: (e: DragEvent<HTMLElement>) => {
      if (latest.current.disabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (latest.current.disabled || !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (latest.current.disabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      touch();
      take(Array.from(e.dataTransfer.files));
    },
    "data-file-drop": "",
  };
  const overlay = over ? (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-primary">
      <Upload className="mr-2 h-4 w-4" /> Drop to upload
    </div>
  ) : null;
  const hint = disabled ? null : (
    <>
      <p className="text-xs text-foreground-subtle">
        Drag {multiple ? "files" : "a file"} here, paste {multiple ? "them" : "it"} (Ctrl/⌘ V), or browse.
      </p>
      {refused && <p className="text-xs text-warning">{refused}</p>}
    </>
  );
  return { zoneProps, overlay, hint };
}

/** An area wrapped whole: its children, the drop overlay and the hint line. */
export function FileDrop({ hint = true, className, children, ...opts }: FileDropOptions & {
  /** The line saying it can be dropped or pasted; off where the area has no room. */
  hint?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const drop = useFileDrop(opts);
  return (
    <div className={cn("relative", className)} {...drop.zoneProps}>
      {children}
      {hint && drop.hint && <div className="mt-2 space-y-1">{drop.hint}</div>}
      {drop.overlay}
    </div>
  );
}
