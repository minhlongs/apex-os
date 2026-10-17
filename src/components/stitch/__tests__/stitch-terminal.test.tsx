import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  ARBITRAGE_OPPORTUNITIES,
  CHAIN_TREASURY_RAILS,
  D1_IMMUTABLE_AUDIT_LOGS,
  EXCHANGE_REBATES,
  KYC_ROLLING_TIERS,
  REFERRAL_TIERS,
  STITCH_NAV_TABS,
  WEBHOOK_SANDBOX_PRESETS,
} from '@/data/stitch-terminal-data';
import { StitchTerminalShell } from '../StitchTerminalShell';
import { StitchObsidianBanner } from '../StitchObsidianBanner';

describe('ApexOS Stitch Obsidian Quant Terminal Suite', () => {
  const renderTerminal = (initialLocale: 'en' | 'vi' = 'en') =>
    render(
      <StitchTerminalShell
        initialLocale={initialLocale}
        navTabs={STITCH_NAV_TABS}
        exchanges={EXCHANGE_REBATES}
        referralTiers={REFERRAL_TIERS}
        opportunities={ARBITRAGE_OPPORTUNITIES}
        rails={CHAIN_TREASURY_RAILS}
        kycTiers={KYC_ROLLING_TIERS}
        webhookPresets={WEBHOOK_SANDBOX_PRESETS}
        auditLogs={D1_IMMUTABLE_AUDIT_LOGS}
      />
    );

  it('renders Screen 1 (Cashback Cockpit) by default with 4 exchanges and 3-tier affiliate metrics', () => {
    renderTerminal('en');

    expect(
      screen.getByText('Executive Cashback & Multi-Exchange Settlement')
    ).toBeInTheDocument();
    expect(screen.getByText(/\$28,450\.80/)).toBeInTheDocument();
    expect(screen.getByText('Binance Futures & Spot')).toBeInTheDocument();
    expect(screen.getByText('Bybit Unified Trading')).toBeInTheDocument();
    expect(screen.getByText('OKX Derivatives Hub')).toBeInTheDocument();
    expect(screen.getByText('KuCoin Spot & Perp')).toBeInTheDocument();
    expect(screen.getByText('Tier 1 Direct Affiliates')).toBeInTheDocument();
  });

  it('toggles between English and Vietnamese (EN | VI) locales cleanly', () => {
    renderTerminal('en');

    const localeButton = screen.getByRole('button', {
      name: /Toggle language between English and Vietnamese/i,
    });
    fireEvent.click(localeButton);

    expect(
      screen.getByText('Tổng Quan Hoàn Phí & Thanh Toán Tự Động')
    ).toBeInTheDocument();
    expect(screen.getByText('Tuyến 1 Trực Tiếp')).toBeInTheDocument();
  });

  it('switches to Screen 2 (Arbitrage & Deals) and computes the $810.00/yr canonical savings benchmark', () => {
    renderTerminal('en');

    fireEvent.click(screen.getByRole('button', { name: /2\.\s*Arbitrage & Deals/i }));

    expect(
      screen.getByText('Interactive Fee Arbitrage Calculator & Deal Crawler')
    ).toBeInTheDocument();
    expect(screen.getAllByText(/\$810\.00/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('BTC/USDT PERP')).toBeInTheDocument();
  });

  it('switches to Screen 3 (Multi-Chain Payouts) and validates Stellar, Ethereum, and Solana addresses', () => {
    renderTerminal('en');

    fireEvent.click(screen.getByRole('button', { name: /3\.\s*Multi-Chain Payouts/i }));

    expect(
      screen.getByText('TreasuryHealthService & D1 Atomic Batch Settlement')
    ).toBeInTheDocument();
    expect(screen.getByText('VALID_CHECKSUM · OFAC_CLEAN')).toBeInTheDocument();

    const addressInput = screen.getByLabelText(/Destination Address/i);
    fireEvent.change(addressInput, { target: { value: 'invalid_wallet' } });
    expect(screen.getByText('INVALID_ADDRESS_FORMAT')).toBeInTheDocument();
  });

  it('switches to Screen 4 (KYC & Fraud Shield) and simulates OFAC SDN sanctions blocking', () => {
    renderTerminal('en');

    fireEvent.click(screen.getByRole('button', { name: /4\.\s*KYC & Fraud Shield/i }));

    expect(
      screen.getByText('KYC Compliance, OFAC Sanctions & Click Anomaly Command')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Simulate OFAC SDN Match/i }));
    expect(screen.getByText(/status = compliance_blocked/i)).toBeInTheDocument();
  });

  it('switches to Screens 7 & 8 (Webhook & Surge Lab) and tests HMAC tampering + EIP-1559 Circuit Breaker', () => {
    renderTerminal('en');

    fireEvent.click(screen.getByRole('button', { name: /7\.\s*Webhook & Surge Lab/i }));

    expect(
      screen.getByText('Multi-Exchange Webhook Replay & Treasury Circuit Breaker Lab')
    ).toBeInTheDocument();
    expect(screen.getByText('200 OK · HMAC_SIGNATURE_VERIFIED')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Simulate Tampered HMAC/i }));
    expect(screen.getByText('401 UNAUTHORIZED · SIGNATURE_MISMATCH')).toBeInTheDocument();

    const ethGasSlider = screen.getByLabelText(/Ethereum EIP-1559 Base Fee/i);
    fireEvent.change(ethGasSlider, { target: { value: '240' } });
    expect(screen.getByText(/CRITICAL · CIRCUIT_OPEN/i)).toBeInTheDocument();
  });

  it('switches to Screen 9 (D1 Audit Explorer) and verifies SQLite immutability trigger enforcement', () => {
    renderTerminal('en');

    fireEvent.click(screen.getByRole('button', { name: /9\.\s*D1 Audit Explorer/i }));

    expect(
      screen.getByText('Forensic D1 Audit Trail & SQLite Immutability Guard')
    ).toBeInTheDocument();
    expect(screen.getByText('pay_stellar_8821')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Simulate SQL DELETE\/UPDATE Tamper/i }));
    expect(screen.getByText(/SQLITE_CONSTRAINT_TRIGGER/i)).toBeInTheDocument();
  });

  it('switches to Screen 10 (BYOK Key Vault) and enforces read-only API key scope policy', () => {
    renderTerminal('en');

    fireEvent.click(screen.getByRole('button', { name: /10\.\s*BYOK Key Vault/i }));

    expect(
      screen.getByText('Zero-Knowledge BYOK Envelope Vault & Read-Only Policy Guard')
    ).toBeInTheDocument();
    expect(screen.getByText('200 SEALED · READ_ONLY_VERIFIED')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Simulate Key With Withdraw Scope/i }));
    expect(screen.getByText('403 FORBIDDEN · WITHDRAW_SCOPE_REJECTED')).toBeInTheDocument();
  });

  it('renders StitchObsidianBanner deep-link bridge for core app routes', () => {
    render(
      <StitchObsidianBanner
        locale="en"
        targetTab="payouts"
        screenLabel="Screen 3 · Multi-Chain Payout Rails"
      />
    );

    expect(screen.getByText('Screen 3 · Multi-Chain Payout Rails')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Launch Stitch Quant Terminal/i })).toHaveAttribute(
      'href',
      '/en/terminal?tab=payouts'
    );
  });
});
