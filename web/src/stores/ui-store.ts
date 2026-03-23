import { create } from 'zustand'

interface UIState {
  /** Currently active view/tab */
  activeView: 'teams' | 'monitor' | 'settings'
  setActiveView: (view: UIState['activeView']) => void

  /** Whether the agent sidebar is collapsed */
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void

  /** Theme preference (dark is always default for now) */
  theme: 'dark' | 'light'
  setTheme: (theme: UIState['theme']) => void

  /** Monitor tab per team (persists across navigation) */
  monitorTab: Record<string, 'summary' | 'messages' | 'plan'>
  setMonitorTab: (teamId: string, tab: 'summary' | 'messages' | 'plan') => void
  getMonitorTab: (teamId: string, defaultTab: 'summary' | 'messages' | 'plan') => 'summary' | 'messages' | 'plan'
}

export const useUIStore = create<UIState>((set, get) => ({
  activeView: 'teams',
  setActiveView: (view) => set({ activeView: view }),

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  theme: 'dark',
  setTheme: (theme) => set({ theme }),

  monitorTab: {},
  setMonitorTab: (teamId, tab) => set((s) => ({ monitorTab: { ...s.monitorTab, [teamId]: tab } })),
  getMonitorTab: (teamId, defaultTab) => get().monitorTab[teamId] ?? defaultTab,
}))
