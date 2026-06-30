'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useWalletStore } from '@/lib/wallet/wallet-store'
import {
  connectMetaMask,
  connectPhantom,
  connectXPortal,
  disconnectWallet,
  getAvailableWallets,
  isMetaMaskInstalled,
  isPhantomInstalled,
  isXPortalInstalled,
} from '@/lib/wallet/wallet-utils'
import type { WalletType } from '@/types/wallet'

interface WalletOption {
  type: WalletType
  name: string
  icon?: React.ReactNode
  installed: boolean
}

function MetamaskIcon() {
  return (
    <svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-6 h-6">
      <path
        d="M33.28 26.72a23.84 23.84 0 0 1-7.8 2.92 23.84 23.84 0 0 1-8.08-2.92 17.24 17.24 0 0 0-6.24-2.16c-4.8 0-8.68 3.88-8.68 8.68 0 1.6.56 3.08 1.48 4.2-.04.24-.28 1.4.4 1.4h16.8c.72 0 1.36-.56 1.48-1.28.12-.72-.6-1.4-.84-1.88-.56-1.12-1.52-2.12-2.76-2.84-4.4-2.56-8.32-3.28-12.6-3.28-2.96 0-5.72.6-8.08 1.72-2.36 1.12-4.28 2.72-5.6 4.72a10.8 10.8 0 0 0 2.16 5.04c.16.28.52.32.76.16 1.68-.96 3.48-1.52 5.32-1.52 4.32 0 8.2 2.4 10.12 5.88.68 1.24.84 2.6.56 4-.12.72-.6 2.08-1.88 1.4-2.24-1.16-4.4-1.88-6.72-1.88-7.84 0-14.28 5.44-14.28 12.28 0 .88.12 1.72.36 2.52.16.64.76 1.12 1.48.92.72-.2 1.44-.6 2.08-1.16.04 0 .08 0 .12 0 2.48 1.56 5.56 2.4 8.6 2.4 4.44 0 8.32-1.88 10.68-5.12 1.2-1.64 1.68-3.64 1.36-5.52-.04-.16-.12-.28-.2-.4a9.08 9.08 0 0 0-.64-3.28zM11.48 18.44a3.4 3.4 0 0 1 1.6-.56c.8 0 1.44.6 1.6 1.4.12.8-.36 1.56-1.16 1.84a2.68 2.68 0 0 1-1.6.56 2.72 2.72 0 0 1-2.76-2.92c0-.72.56-1.36 1.44-1.52.28-.04.6 0 .84.2.12.08.2.12.32.16.12.08.2.04.28-.08.08-.12.04-.24-.04-.32-.16-.2-.48-.24-.72-.16-.4.12-.72.32-1 .56-.28.2-.52.44-.68.72zM20.6 17.32c.16-.36.52-.6.96-.64l12.56-.64c.88 0 1.44.68 1.32 1.48-.04.32-.2 1.4-.4 1.4h-2.32c-.44 0-.84.36-.88.84-.04.48.44.92.88.92h10.6c.68 0 1.2.52 1.2 1.2 0 .68-.52 1.2-1.2 1.2h-10.6c-.44 0-.84.36-.88.84-.04.48.44.92.88.92h2.4c.48 0 .88-.4.88-.92 0-.2-.12-.4-.24-.52-.4-.36-1-.52-1.6-.6l-12.8.56c-1 .44-1.6 1.48-1.2 2.4.12.28.48.44.84.4.36-.04.72-.2.96-.52.2-.24.32-.56.28-.92-.04-.44-.28-.84-.68-1.08-.16-.12-.36-.16-.56-.12-.2.04-.36.16-.44.32-.08.16-.12.32-.04.48.04.08.12.16.2.16.04 0 .08 0 .12-.04.12-.12.32-.2.52-.16.2.04.36.2.4.36.04.16 0 .36-.12.52z"
        fill="currentColor"
      />
    </svg>
  )
}

function PhantomIcon() {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-6 h-6">
      <path
        d="M16 2C8.268 2 2 8.268 2 16s6.268 14 14 14 14-6.268 14-14S23.732 2 16 2zm0 26C9.373 28 4 22.627 4 16S9.373 4 16 4s12 5.373 12 12-5.373 12-12 12z"
        fill="currentColor"
      />
      <path
        d="M16 6c-6.627 0-12 5.373-12 12s5.373 12 12 12 12-5.373 12-12-5.373-12-12-12zm0 20c-4.418 0-8-3.582-8-8s3.582-8 8-8 8 3.582 8 8-3.582 8-8 8z"
        fill="currentColor"
      />
    </svg>
  )
}

function XPortalIcon() {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-6 h-6">
      <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2" />
      <path d="M10 16h12M16 10v12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function LoadingSpinner() {
  return (
    <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  )
}

export default function WalletConnect() {
  const {
    address,
    walletType,
    isConnected,
    isConnecting,
    error,
    setConnecting,
    setConnected,
    setDisconnected,
    setError,
    clearError,
  } = useWalletStore()

  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const handleConnect = useCallback(
    async (type: WalletType) => {
      if (!mountedRef.current) return

      setConnecting(true)
      clearError()

      let result
      switch (type) {
        case 'metamask':
          result = await connectMetaMask()
          break
        case 'phantom':
          result = await connectPhantom()
          break
        case 'xportal':
          result = await connectXPortal()
          break
        default:
          result = { success: false, error: 'Unknown wallet type' }
      }

      if (!mountedRef.current) return

      if (result.success && result.address) {
        setConnected(result.address, result.chainId ?? 1, type)
      } else {
        setError(result.error ?? 'Connection failed')
      }
    },
    [setConnecting, setConnected, setError, clearError]
  )

  const handleDisconnect = useCallback(async () => {
    if (address && walletType) {
      await disconnectWallet(walletType)
    }
    setDisconnected()
  }, [address, walletType, setDisconnected])

  const availableWallets: WalletOption[] = getAvailableWallets()

  const truncateAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`
  }

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
          <div className={`w-2 h-2 rounded-full bg-green-500`} />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {truncateAddress(address)}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400 hidden sm:inline">
            {walletType}
          </span>
        </div>
        <button
          onClick={handleDisconnect}
          className="px-4 py-2 text-sm font-medium text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 transition-colors"
        >
          Disconnect
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-start gap-3">
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <button
            onClick={clearError}
            className="text-xs text-red-500 hover:text-red-700 mt-1"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {availableWallets.map((wallet) => (
          <button
            key={wallet.type}
            onClick={() => handleConnect(wallet.type)}
            disabled={!wallet.installed || isConnecting}
            className={`
              flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm
              transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed
              ${
                wallet.installed
                  ? 'bg-brand-600 hover:bg-brand-700 text-white shadow-sm hover:shadow'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500'
              }
              ${isConnecting ? 'cursor-wait' : ''}
            `}
          >
            {isConnecting ? (
              <LoadingSpinner />
            ) : (
              <span className="flex items-center justify-center">{wallet.icon}</span>
            )}
            <span>{wallet.installed ? wallet.name : `${wallet.name} (not installed)`}</span>
          </button>
        ))}
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400">
        Connect your wallet to earn cashback and affiliate commissions.
      </p>
    </div>
  )
}
