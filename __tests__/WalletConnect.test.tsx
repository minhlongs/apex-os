import { renderHook, act } from '@testing-library/react'
import { useWalletStore } from '@/lib/wallet/wallet-store'
import { describe, it, expect } from '@jest/globals'

describe('useWalletStore', () => {
  it('has correct initial state', () => {
    const { result } = renderHook(() => useWalletStore())
    expect(result.current.isConnected).toBe(false)
    expect(result.current.isConnecting).toBe(false)
    expect(result.current.address).toBeNull()
    expect(result.current.chainId).toBeNull()
    expect(result.current.walletType).toBe('unknown')
    expect(result.current.error).toBeNull()
  })

  it('sets connecting state', () => {
    const { result } = renderHook(() => useWalletStore())

    act(() => {
      result.current.setConnecting(true)
    })

    expect(result.current.isConnecting).toBe(true)
    expect(result.current.isConnected).toBe(false)
  })

  it('sets connected state', () => {
    const { result } = renderHook(() => useWalletStore())

    act(() => {
      result.current.setConnected('0x1234567890abcdef1234567890abcdef12345678', 1, 'metamask')
    })

    expect(result.current.isConnected).toBe(true)
    expect(result.current.isConnecting).toBe(false)
    expect(result.current.address).toBe('0x1234567890abcdef1234567890abcdef12345678')
    expect(result.current.chainId).toBe(1)
    expect(result.current.walletType).toBe('metamask')
    expect(result.current.error).toBeNull()
  })

  it('sets error state', () => {
    const { result } = renderHook(() => useWalletStore())

    act(() => {
      result.current.setError('Connection failed')
    })

    expect(result.current.error).toBe('Connection failed')
    expect(result.current.isConnecting).toBe(false)
  })

  it('clears error', () => {
    const { result } = renderHook(() => useWalletStore())

    act(() => {
      result.current.setError('Some error')
    })

    act(() => {
      result.current.clearError()
    })

    expect(result.current.error).toBeNull()
  })

  it('disconnects properly', () => {
    const { result } = renderHook(() => useWalletStore())

    // First connect
    act(() => {
      result.current.setConnected('0xabc123', 1, 'phantom')
    })

    expect(result.current.isConnected).toBe(true)

    // Then disconnect
    act(() => {
      result.current.setDisconnected()
    })

    expect(result.current.isConnected).toBe(false)
    expect(result.current.isConnecting).toBe(false)
    expect(result.current.address).toBeNull()
    expect(result.current.chainId).toBeNull()
    expect(result.current.walletType).toBe('unknown')
    expect(result.current.error).toBeNull()
  })
})
