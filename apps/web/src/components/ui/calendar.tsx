"use client";

import { DayPicker } from "react-day-picker";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

export function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-2", className)}
      classNames={{
        months: "flex flex-col",
        month: "space-y-3",
        month_caption: "flex items-center justify-center h-8 relative",
        caption_label: "text-sm font-medium",
        nav: "flex items-center gap-1 absolute inset-x-0 justify-between px-1",
        button_previous:
          "inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted",
        button_next:
          "inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "w-8 text-xs font-medium text-foreground-subtle",
        week: "flex w-full mt-1",
        day: "h-8 w-8 p-0 text-center text-sm",
        day_button:
          "inline-flex h-8 w-8 items-center  justify-center rounded-md hover:bg-surface-muted aria-selected:bg-primary aria-selected:text-primary-foreground selected:bg-primary selected:text-primary-foreground",
        today: "font-semibold text-primary",
        outside: "text-foreground-subtle/50",
        disabled: "opacity-40",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? (
            <ChevronLeft className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          ),
      }}
      {...props}
    />
  );
}
