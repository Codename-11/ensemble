import { create } from 'zustand'

interface UIState {
  /** Currently active view/tab */
  activeView: 'teams' | 'monitor'
  setActiveView: (view: UIState['activeView']) => void

  /** Whether the agent sidebar is collapsed */
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void

  /** Theme preference (dark is always default for now) */
  theme: 'dark' | 'light'
  setTheme: (theme: UIState['theme']) => void
}

export const useUIStore = create<UIState>((set) => ({
  activeView: 'teams',
  setActiveView: (view) => set({ activeView: view }),

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  theme: 'dark',
  setTheme: (theme) => set({ theme }),
}))
