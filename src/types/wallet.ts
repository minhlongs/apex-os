export type WalletType = 'metamask' | 'phantom' | 'xportal' | 'unknown'

export interface WalletState {
  address: string | null
  chainId: number | null
  walletType: WalletType
  isConnected: boolean
  isConnecting: boolean
  error: string | null
}

export interface WalletConnectionResult {
  success: boolean
  address?: string
  chainId?: number
  walletType?: WalletType
  error?: string
}
