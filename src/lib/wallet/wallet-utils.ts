import type { WalletType, WalletConnectionResult } from '@/types/wallet'

export function isMetaMaskInstalled(): boolean {
  return typeof window !== 'undefined' && typeof window.ethereum !== 'undefined'
}

export function isPhantomInstalled(): boolean {
  return typeof window !== 'undefined' && typeof window.solana !== 'undefined'
}

export function isXPortalInstalled(): boolean {
  return (
    typeof window !== 'undefined' &&
    (typeof window.stellar !== 'undefined' ||
      typeof (window as { xportal?: unknown }).xportal !== 'undefined' ||
    // Some xPortal versions inject 'xportal' object
      typeof (window as { stellarSdk?: unknown }).stellarSdk !== 'undefined')
  )
}

export async function connectMetaMask(): Promise<WalletConnectionResult> {
  try {
    if (!isMetaMaskInstalled()) {
      return {
        success: false,
        error: 'MetaMask is not installed. Please install MetaMask to continue.',
      }
    }

    const ethereum = window.ethereum!;
    const accounts = await ethereum.request({
      method: 'eth_requestAccounts',
    }) as string[]

    if (accounts.length === 0) {
      return {
        success: false,
        error: 'No accounts found. Please unlock MetaMask and try again.',
      }
    }

    const chainId = await ethereum.request({
      method: 'eth_chainId',
    }) as string

    return {
      success: true,
      address: accounts[0],
      chainId: parseInt(chainId, 16),
      walletType: 'metamask',
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect MetaMask',
    }
  }
}

export async function connectPhantom(): Promise<WalletConnectionResult> {
  try {
    if (!isPhantomInstalled()) {
      return {
        success: false,
        error: 'Phantom wallet is not installed. Please install Phantom to continue.',
      }
    }

    const solana = window.solana!;
    if (!solana.isPhantom) {
      return {
        success: false,
        error: 'Phantom wallet not detected properly.',
      }
    }

    const response = await solana.connect()
    const { publicKey } = response

    return {
      success: true,
      address: publicKey.toString(),
      chainId: 1, // Solana doesn't have chainId, using placeholder
      walletType: 'phantom',
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect Phantom',
    }
  }
}

export async function connectXPortal(): Promise<WalletConnectionResult> {
  try {
    if (!isXPortalInstalled()) {
      return {
        success: false,
        error: 'xPortal wallet is not installed. Please install xPortal to continue.',
      }
    }

    // xPortal uses Stellar wallet connection
    const stellar = (window as { stellar?: { login: () => Promise<{ address: string }> } }).stellar

    if (!stellar?.login) {
      return {
        success: false,
        error: 'xPortal wallet not detected properly.',
      }
    }

    const result = await stellar.login()
    const address = result?.address

    if (!address) {
      return {
        success: false,
        error: 'Failed to get address from xPortal.',
      }
    }

    return {
      success: true,
      address,
      chainId: 1, // Stellar doesn't use chainId
      walletType: 'xportal',
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect xPortal',
    }
  }
}

export async function disconnectWallet(walletType: WalletType): Promise<void> {
  switch (walletType) {
    case 'metamask':
      // MetaMask doesn't programmatically disconnect, user must disconnect manually
      break
    case 'phantom':
      if (isPhantomInstalled()) {
        await window.solana!.disconnect()
      }
      break
    case 'xportal':
      // xPortal handles disconnect via their UI
      break
  }
}

export function getAvailableWallets(): { type: WalletType; name: string; installed: boolean }[] {
  return [
    { type: 'metamask', name: 'MetaMask', installed: isMetaMaskInstalled() },
    { type: 'phantom', name: 'Phantom', installed: isPhantomInstalled() },
    { type: 'xportal', name: 'xPortal', installed: isXPortalInstalled() },
  ]
}

// Declare window extensions for TypeScript
declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
      on: (event: string, callback: (...args: unknown[]) => void) => void
      removeListener: (event: string, callback: (...args: unknown[]) => void) => void
    }
    solana?: {
      isPhantom: boolean
      connect: () => Promise<{ publicKey: { toString: () => string } }>
      disconnect: () => Promise<void>
    }
    stellar?: {
      login: () => Promise<{ address: string }>
    }
    xportal?: unknown
    stellarSdk?: unknown
  }
}
