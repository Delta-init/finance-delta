"use client";

import {
  Children,
  Fragment,
  cloneElement,
  forwardRef,
  isValidElement,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactElement,
  type ReactNode,
} from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 text-sm shadow-xs transition-colors data-[placeholder]:text-foreground-subtle focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-50 [&>span]:line-clamp-1",
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 shrink-0 text-foreground-subtle" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";

/**
 * A list long enough that reading it is slower than typing at it.
 *
 * Below this a search box is clutter — a status dropdown with four options
 * does not need one. Above it, scrolling a customer list to find a name is
 * the thing people were doing instead.
 */
const SEARCH_FROM = 6;

/** Every word an option shows, so a search matches what the reader can see. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (isValidElement(node)) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** Options in the tree, however they are nested or grouped. */
function countItems(children: ReactNode): number {
  let n = 0;
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === SelectItem) n += 1;
    else n += countItems((child.props as { children?: ReactNode }).children);
  });
  return n;
}

/** Options in the tree whose words include the needle. */
function countMatches(children: ReactNode, needle: string): number {
  let n = 0;
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const props = child.props as { children?: ReactNode };
    if (child.type === SelectItem) n += textOf(props.children).toLowerCase().includes(needle) ? 1 : 0;
    else n += countMatches(props.children, needle);
  });
  return n;
}

/**
 * The same tree with options that do not match hidden — never removed.
 *
 * Removing them (as this did until 2026-10-21) unmounted and remounted the
 * options on the first keystroke; Radix then moved focus to the selected
 * option, and the search box lost focus after one letter. Hiding keeps every
 * option mounted, and the tree is walked the same way whatever is typed, so
 * nothing remounts. Grouped options and options built by a `.map()` narrow
 * the same way; a group whose options are all hidden is hidden with them
 * rather than left as a heading over nothing.
 */
function markItems(children: ReactNode, needle: string): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    const props = child.props as { children?: ReactNode; className?: string };

    if (child.type === SelectItem) {
      const hide = !!needle && !textOf(props.children).toLowerCase().includes(needle);
      return cloneElement(child as ReactElement<{ className?: string; "aria-hidden"?: boolean }>, {
        className: cn(props.className, hide && "hidden"),
        "aria-hidden": hide || undefined,
      });
    }
    if (props.children === undefined) return child;

    const inner = markItems(props.children, needle);
    const empty = !!needle && countItems(props.children) > 0 && countMatches(props.children, needle) === 0;
    // A fragment takes no class; its options are hidden one by one already.
    const extra = child.type === Fragment ? {} : { className: cn(props.className, empty && "hidden") };
    return cloneElement(child as ReactElement<{ className?: string; children?: ReactNode }>, { ...extra, children: inner });
  });
}

export const SelectContent = forwardRef<
  ElementRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content> & {
    /** Force the search box on or off. Left alone, a long list gets one. */
    searchable?: boolean;
    searchPlaceholder?: string;
  }
>(({ className, children, position = "popper", searchable, searchPlaceholder, ...props }, ref) => {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const total = useMemo(() => countItems(children), [children]);
  const showSearch = searchable ?? total >= SEARCH_FROM;
  const needle = query.trim().toLowerCase();
  // Always walked when searchable, typed or not, so the options keep their identity and never remount.
  const shown = useMemo(() => (showSearch ? markItems(children, needle) : children), [children, needle, showSearch]);
  const empty = showSearch && needle && countMatches(children, needle) === 0;

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        className={cn(
          "relative z-50 max-h-72 min-w-[8rem] overflow-hidden rounded-lg border border-border bg-surface shadow-lg",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95",
          position === "popper" && "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className,
        )}
        {...props}
        // Reopening should not still be showing the last search.
        onCloseAutoFocus={(e) => { setQuery(""); props.onCloseAutoFocus?.(e); }}
        // Focus can still reach the list (the mouse moving over an option takes it there). A letter typed
        // then goes to the search, not to Radix's jump-to-option, and the search box gets focus back.
        onKeyDown={(e) => {
          props.onKeyDown?.(e);
          if (!showSearch || e.defaultPrevented || e.target === inputRef.current || e.ctrlKey || e.metaKey || e.altKey) return;
          if (e.key.length === 1 || e.key === "Backspace") {
            e.preventDefault();
            setQuery((q) => (e.key === "Backspace" ? q.slice(0, -1) : q + e.key));
            inputRef.current?.focus();
          }
        }}
      >
        {showSearch && (
          <div
            className="sticky top-0 z-10 border-b border-border bg-surface p-1.5"
            // Radix moves the highlight on any keystroke and steals focus back
            // to the list. Both are right for a list and wrong for a text box,
            // so the input keeps its own keys and its own focus.
            onKeyDown={(e) => {
              if (e.key !== "Escape" && e.key !== "Enter") e.stopPropagation();
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-subtle" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder ?? "Search…"}
                autoFocus
                className="h-8 w-full rounded-md border border-border bg-surface pl-8 pr-2 text-sm outline-none placeholder:text-foreground-subtle focus:border-primary focus:ring-2 focus:ring-ring/30"
              />
            </div>
          </div>
        )}
        <SelectPrimitive.Viewport
          className={cn(
            "p-1",
            position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)]",
          )}
        >
          {shown}
          {empty && (
            <p className="px-3 py-6 text-center text-sm text-foreground-muted">
              Nothing matches “{query.trim()}”.
            </p>
          )}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});
SelectContent.displayName = "SelectContent";

export const SelectItem = forwardRef<
  ElementRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-pointer select-none items-center rounded-md py-1.5 pl-8 pr-2 text-sm outline-none transition-colors data-[highlighted]:bg-surface-muted data-[state=checked]:font-medium data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-4 w-4 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4 text-primary" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = "SelectItem";
