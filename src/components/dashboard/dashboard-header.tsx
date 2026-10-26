import { useAuth } from '../../contexts/auth-context'

interface DashboardHeaderProps {
  onMenuClick?: () => void
}

export function DashboardHeader({ onMenuClick }: DashboardHeaderProps) {
  const { user, signOut } = useAuth()

  return (
    <header className="bg-stitch-surface border-b border-stitch-border">
      <div className="flex items-center justify-between px-4 py-3">
        {/* Left: Menu toggle + Logo */}
        <div className="flex items-center space-x-3">
          <button
            onClick={onMenuClick}
            className="lg:hidden p-2 rounded-md text-stitch-muted hover:bg-stitch-well hover:text-stitch-primary focus:outline-none focus:ring-2 focus:ring-stitch-indigo"
            aria-label="Toggle menu"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-stitch-emerald" aria-hidden="true" />
            <h1 className="text-xl font-bold tracking-tight text-stitch-primary">ApexOS</h1>
            <span className="hidden sm:inline-flex items-center rounded border border-stitch-border bg-stitch-well px-1.5 py-0.5 font-mono text-[10px] font-semibold text-stitch-indigo">
              OBSIDIAN
            </span>
          </div>
        </div>

        {/* Right: User email + Sign out */}
        <div className="flex items-center space-x-4">
          <span className="hidden sm:block font-mono text-xs text-stitch-muted">{user?.email}</span>
          <button
            onClick={() => signOut()}
            className="text-sm text-stitch-indigo hover:text-stitch-violet font-medium transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  )
}
