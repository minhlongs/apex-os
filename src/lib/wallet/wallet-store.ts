import { create } from 'zustand'
import type { WalletState, WalletType } from '@/types/wallet'

interface WalletStore extends WalletState {
  setConnecting: (value: boolean) => void
  setConnected: (address: string, chainId: number, walletType: WalletType) => void
  setDisconnected: () => void
  setError: (error: string | null) => void
  clearError: () => void
}

export const useWalletStore = create<WalletStore>()((set) => ({
  address: null,
  chainId: null,
  walletType: 'unknown',
  isConnected: false,
  isConnecting: false,
  error: null,
  setConnecting: (isConnecting) => set({ isConnecting }),
  setConnected: (address, chainId, walletType) =>
    set({
      address,
      chainId,
      walletType,
      isConnected: true,
      isConnecting: false,
      error: null,
    }),
  setDisconnected: () =>
    set({
      address: null,
      chainId: null,
      walletType: 'unknown',
      isConnected: false,
      isConnecting: false,
    }),
  setError: (error) => set({ error, isConnecting: false }),
  clearError: () => set({ error: null }),
}))
