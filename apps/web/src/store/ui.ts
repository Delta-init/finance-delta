import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Small, ephemeral global UI state only — never server data (that's React Query). */
interface UiState {
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;
  mobileSidebarOpen: boolean;
  setMobileSidebarOpen: (v: boolean) => void;
  /** The sidebar's categories opened or closed by hand, by key (2026-10-22); one not in here follows the page. */
  navGroups: Record<string, boolean>;
  setNavGroup: (key: string, open: boolean) => void;
}

/** Storage that never throws: a private window or blocked site data just means nothing is remembered. */
const safeStorage = createJSONStorage(() => ({
  getItem: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not remembered */ } },
  removeItem: (k: string) => { try { localStorage.removeItem(k); } catch { /* nothing to remove */ } },
}));

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      mobileSidebarOpen: false,
      setMobileSidebarOpen: (v) => set({ mobileSidebarOpen: v }),
      navGroups: {},
      setNavGroup: (key, open) => set((s) => ({ navGroups: { ...s.navGroups, [key]: open } })),
    }),
    {
      // Minimised or not, and which categories are open, kept across reloads (the user, 2026-10-22: "fix the
      // minimise view"). Read after the first render (SidebarProvider), so the server's page and the first client
      // render agree.
      name: "finance-ui",
      storage: safeStorage,
      partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed, navGroups: s.navGroups }),
      skipHydration: true,
    },
  ),
);
