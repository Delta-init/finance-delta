"use client";

/**
 * ResponsiveModal — one API, two presentations:
 *   • desktop (≥ lg): a centered Dialog (Radix)
 *   • mobile  (< lg): a bottom Drawer (Vaul, drag-to-dismiss)
 *
 * Usage:
 *   <ResponsiveModal open={open} onOpenChange={setOpen}>
 *     <ResponsiveModalContent>
 *       <ResponsiveModalHeader>
 *         <ResponsiveModalTitle>New user</ResponsiveModalTitle>
 *         <ResponsiveModalDescription>…</ResponsiveModalDescription>
 *       </ResponsiveModalHeader>
 *       <form>…<ResponsiveModalFooter>…</ResponsiveModalFooter></form>
 *     </ResponsiveModalContent>
 *   </ResponsiveModal>
 */
import {
  createContext,
  useContext,
  type ComponentProps,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from "./drawer";

const ModalCtx = createContext<{ isMobile: boolean }>({ isMobile: false });

interface RootProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

export function ResponsiveModal({ open, onOpenChange, children }: RootProps) {
  const isMobile = useIsMobile();
  const Root = isMobile ? Drawer : Dialog;
  return (
    <ModalCtx.Provider value={{ isMobile }}>
      <Root open={open} onOpenChange={onOpenChange}>
        {children}
      </Root>
    </ModalCtx.Provider>
  );
}

export function ResponsiveModalTrigger(
  props: ComponentProps<typeof DialogTrigger>,
) {
  const { isMobile } = useContext(ModalCtx);
  const Trigger = isMobile ? DrawerTrigger : DialogTrigger;
  return <Trigger {...props} />;
}

export function ResponsiveModalClose(props: ComponentProps<typeof DialogClose>) {
  const { isMobile } = useContext(ModalCtx);
  const Close = isMobile ? DrawerClose : DialogClose;
  return <Close {...props} />;
}

export function ResponsiveModalContent({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { isMobile } = useContext(ModalCtx);
  if (isMobile) {
    return (
      <DrawerContent className={className}>
        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-6 pt-2">
          {children}
        </div>
      </DrawerContent>
    );
  }
  return (
    <DialogContent className={cn("max-h-[85vh] overflow-y-auto", className)}>
      {children}
    </DialogContent>
  );
}

export function ResponsiveModalHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex flex-col gap-1.5 text-left", className)} {...props} />
  );
}

export function ResponsiveModalFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

export function ResponsiveModalTitle(
  props: ComponentProps<typeof DialogTitle>,
) {
  const { isMobile } = useContext(ModalCtx);
  const Title = isMobile ? DrawerTitle : DialogTitle;
  return <Title {...props} />;
}

export function ResponsiveModalDescription(
  props: ComponentProps<typeof DialogDescription>,
) {
  const { isMobile } = useContext(ModalCtx);
  const Description = isMobile ? DrawerDescription : DialogDescription;
  return <Description {...props} />;
}
