import { render, screen } from '@testing-library/react'
import { AuthProvider } from '@/contexts/auth-context'

// Mock fetch for auth context tests
global.fetch = async () =>
  ({ json: async () => ({ user: null }) }) as Response

describe('AuthProvider', () => {
  it('renders children without crashing', () => {
    render(
      <AuthProvider>
        <div data-testid="child">Test Child</div>
      </AuthProvider>
    )
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })
})
