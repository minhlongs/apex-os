/**
 * src/lib/payouts/stellar-horizon-transport.ts
 *
 * Production Horizon Transport for Stellar Protocol 30 ("Bell") Turnkey HSM Settlements
 *
 * Implements `StellarBroadcastTransport` using `@stellar/stellar-sdk` v17 without ever
 * holding or accepting a raw `STELLAR_SECRET_KEY` (`S...`) in Cloudflare Worker memory:
 * - Verifies existing Circle USDC trustline (`GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` on mainnet)
 * - Reads 64-bit Horizon account sequence numbers as `bigint`
 * - Builds unsigned Stellar XDR envelopes with exact `stellarSequence`, 7-decimal USDC stroops,
 *   and deterministic `TimeBounds` (`minTime: 0`, `maxTime: timeboundsMaxUnix`)
 * - Submits Turnkey-signed XDR envelopes to Horizon and inspects transaction status for Gate G8 recovery
 */

import type * as StellarSdkTypes from '@stellar/stellar-sdk';
import { withPayoutEffect, type PayoutWorkflow } from './payout-effect-fence';
import type { D1Database } from '../auth/adapters/d1-adapter';
import { normalizeColdTxHash, type ColdPaymentEvidence, type ColdPaymentTransfer } from './cold-payment-evidence';
import type {
  StellarBroadcastTransport,
  StellarBuiltUnsignedTx,
  StellarHorizonTxLookupResult,
} from './broadcast-recovery-machine';
import {
  CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
  CANONICAL_STELLAR_TESTNET_USDC_ISSUER,
  StellarNetwork,
  StellarService,
  formatStellarUsdcAmount,
  resolveStellarNetwork,
} from './stellar-service';

function resolveStellarSdk(): typeof StellarSdkTypes {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@stellar/stellar-sdk') as typeof StellarSdkTypes;
  } catch (err) {
    const isEsmSyntaxError =
      err !== null &&
      typeof err === 'object' &&
      (err as { name?: string }).name === 'SyntaxError';
    if (isEsmSyntaxError && typeof process !== 'undefined' && process.versions?.node) {
      const getBuiltin = (
        process as unknown as { getBuiltinModule?: (id: string) => unknown }
      ).getBuiltinModule;
      if (typeof getBuiltin === 'function') {
        const nodeMod = getBuiltin('node:module') as {
          createRequire: (origin: string) => NodeRequire;
        };
        return nodeMod.createRequire(__filename)('@stellar/stellar-sdk') as typeof StellarSdkTypes;
      }
    }
    throw err;
  }
}

export interface HorizonStellarBroadcastTransportOptions {
  network?: StellarNetwork;
  horizonUrl?: string;
  usdcIssuer?: string;
  feeStroops?: number;
  stellarService?: StellarService;
}

interface RawHorizonColdTransaction {
  hash: string;
  ledger: number;
  successful: boolean;
  operation_count: number;
}

interface RawHorizonOperation {
  id: string;
  paging_token: string;
  type: string;
  transaction_hash: string;
  transaction_successful: boolean;
  from?: string;
  from_muxed?: string;
  to?: string;
  to_muxed?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}

interface RawHorizonSubmitResponse {
  hash?: string;
  id?: string;
  successful?: boolean;
}

export class HorizonStellarBroadcastTransport implements StellarBroadcastTransport {
  private readonly network: StellarNetwork;
  private readonly usdcIssuer: string;
  private readonly configuredUsdcIssuer: string | undefined;
  private readonly feeStroops: number;
  private readonly stellarService: StellarService;
  private readonly horizonUrl: string;
  private readonly horizonServer: StellarSdkTypes.Horizon.Server;

  constructor(options?: HorizonStellarBroadcastTransportOptions) {
    const StellarSdk = resolveStellarSdk();
    this.network = resolveStellarNetwork(options?.network);
    const defaultIssuer =
      this.network === StellarNetwork.MAINNET
        ? CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER
        : CANONICAL_STELLAR_TESTNET_USDC_ISSUER;
    const rawIssuer = options?.usdcIssuer ?? process.env.STELLAR_USDC_ISSUER;
    this.configuredUsdcIssuer = rawIssuer?.trim() || undefined;
    const candidateIssuer = this.configuredUsdcIssuer ?? defaultIssuer;
    this.usdcIssuer = StellarSdk.StrKey.isValidEd25519PublicKey(candidateIssuer)
      ? candidateIssuer
      : CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER;
    this.feeStroops = options?.feeStroops ?? 300;

    const horizonUrl =
      options?.horizonUrl ??
      process.env.STELLAR_HORIZON_URL ??
      (this.network === StellarNetwork.MAINNET
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org');

    this.stellarService =
      options?.stellarService ??
      new StellarService({
        network: this.network,
        horizonUrl,
        usdcIssuer: this.usdcIssuer,
      });

    this.horizonUrl = horizonUrl.replace(/\/+$/, '');
    this.horizonServer = new StellarSdk.Horizon.Server(horizonUrl);
  }

  private getNetworkPassphrase(): string {
    const StellarSdk = resolveStellarSdk();
    return this.network === StellarNetwork.MAINNET
      ? StellarSdk.Networks.PUBLIC
      : StellarSdk.Networks.TESTNET;
  }

  async hasUsdcTrustline(accountId: string): Promise<boolean> {
    return this.stellarService.hasUsdcTrustline(accountId);
  }

  async getAccountSequence(accountId: string): Promise<bigint> {
    const account = await this.stellarService.getAccount(accountId);
    if (!account || !account.exists) {
      throw new Error(`Stellar hot wallet account does not exist on Horizon: ${accountId}`);
    }
    return BigInt(account.sequence);
  }

  async buildUnsignedUsdcPayment(params: {
    fromAccount: string;
    recipientAddress: string;
    stellarSequence: string;
    amountStroops: bigint;
    amountFormatted7: string;
    timeboundsMaxUnix: number;
    memo?: string;
  }): Promise<StellarBuiltUnsignedTx> {
    const StellarSdk = resolveStellarSdk();
    const targetSeq = BigInt(params.stellarSequence);
    if (targetSeq <= BigInt(0)) {
      throw new Error(`Invalid reserved Stellar sequence: ${params.stellarSequence}`);
    }

    // Stellar TransactionBuilder increments source account sequence by +1 during .build()
    const baseAccountSeq = (targetSeq - BigInt(1)).toString();
    const sourceAccount = new StellarSdk.Account(params.fromAccount, baseAccountSeq);
    const usdcAsset = new StellarSdk.Asset('USDC', this.usdcIssuer);
    const formattedAmount = formatStellarUsdcAmount(params.amountFormatted7);

    let builder = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: String(this.feeStroops),
      networkPassphrase: this.getNetworkPassphrase(),
      timebounds: {
        minTime: 0,
        maxTime: params.timeboundsMaxUnix,
      },
    });

    builder = builder.addOperation(
      StellarSdk.Operation.payment({
        destination: params.recipientAddress,
        asset: usdcAsset,
        amount: formattedAmount,
      })
    );

    if (params.memo && params.memo.trim().length > 0) {
      builder = builder.addMemo(StellarSdk.Memo.text(params.memo.trim().slice(0, 28)));
    }

    const unsignedTx = builder.build();
    if (unsignedTx.sequence !== params.stellarSequence) {
      throw new Error(
        `Built Stellar sequence mismatch: expected ${params.stellarSequence}, got ${unsignedTx.sequence}`
      );
    }

    return {
      unsignedEnvelopeXdr: unsignedTx.toXDR(),
      txHashHex: Buffer.from(unsignedTx.hash()).toString('hex'),
      stellarSequence: unsignedTx.sequence,
      timeboundsMaxUnix: params.timeboundsMaxUnix,
      amountFormatted7: formattedAmount,
    };
  }

  async submitSignedTransaction(params: {
    signedEnvelopeXdr: string;
    signatureBase64: string;
    expectedTxHash: string;
    db: D1Database;
    payoutId: string;
    effect: 'STELLAR_SUBMIT';
    workflow?: PayoutWorkflow;
  }): Promise<{ txHash: string; confirmed: boolean }> {
    const StellarSdk = resolveStellarSdk();
    const parsedTx = StellarSdk.TransactionBuilder.fromXDR(
      params.signedEnvelopeXdr,
      this.getNetworkPassphrase()
    );

    if (parsedTx.signatures.length === 0) {
      throw new Error(
        'Refusing to broadcast unsigned Stellar envelope (0 DecoratedSignatures attached)'
      );
    }

    const actualHash = Buffer.from(parsedTx.hash()).toString('hex').toLowerCase();
    const expectedHash = params.expectedTxHash.replace(/^0x/i, '').toLowerCase();
    if (actualHash !== expectedHash) {
      throw new Error(
        `Signed Stellar envelope hash mismatch: expected ${expectedHash}, got ${actualHash}`
      );
    }

    if (!(parsedTx instanceof StellarSdk.Transaction)) {
      throw new Error('Refusing to submit a fee-bump envelope through the hot payout transport');
    }
    return withPayoutEffect({
      workflow: params.workflow,
      db: params.db,
      payoutId: params.payoutId,
      effect: params.effect,
      payload: params.signedEnvelopeXdr,
      chain: 'stellar', signerAddress: parsedTx.source,
      stellarSequence: parsedTx.sequence, expectedHash: actualHash,
    }, async () => {
      // Horizon POST /transactions accepts URL-encoded signed XDR. Avoid SDK redirect
      // following: one durable grant must never authorize a second HTTP request.
      const response = await fetch(`${this.horizonUrl}/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ tx: params.signedEnvelopeXdr }).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Horizon submit HTTP ${response.status}; outcome unknown`);
      const result = await response.json() as RawHorizonSubmitResponse;
      const txHash = (result.hash ?? result.id)?.toLowerCase();
      if (txHash !== actualHash) throw new Error('Horizon returned an unexpected transaction hash');
      return { txHash, confirmed: result.successful === true };
    });
  }

  get coldPaymentNetwork(): string {
    return `stellar:${this.network}`;
  }

  get coldPaymentAsset(): string {
    const issuer = this.configuredUsdcIssuer;
    if (this.network === StellarNetwork.MAINNET) {
      if (issuer !== undefined && issuer !== CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER) {
        throw new Error('Cold payment requires the canonical Circle mainnet USDC issuer');
      }
      return `USDC:${CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER}`;
    }
    // Testnet tokens are selected by trusted configuration, not the observed transaction.
    if (!issuer || issuer === CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER ||
        !resolveStellarSdk().StrKey.isValidEd25519PublicKey(issuer)) {
      throw new Error('Cold payment requires an explicitly configured valid Stellar testnet USDC issuer');
    }
    return `USDC:${issuer}`;
  }

  private async readColdHorizon<T>(path: string): Promise<T> {
    const response = await fetch(`${this.horizonUrl}/${path}`, {
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Horizon cold payment lookup failed (HTTP ${response.status})`);
    return await response.json() as T;
  }

  async getColdPaymentEvidence(inputHash: string): Promise<ColdPaymentEvidence> {
    const txHash = normalizeColdTxHash('stellar', inputHash);
    const root = await this.readColdHorizon<{ network_passphrase: string }>('');
    if (root.network_passphrase !== this.getNetworkPassphrase()) {
      throw new Error('Cold payment Horizon network does not match the configured network');
    }
    const tx = await this.readColdHorizon<RawHorizonColdTransaction>(`transactions/${txHash}`);
    if (tx.successful !== true || tx.hash !== txHash || !Number.isSafeInteger(tx.ledger) || tx.ledger <= 0 ||
        !Number.isSafeInteger(tx.operation_count) || tx.operation_count <= 0) {
      throw new Error('Cold payment requires a successful included Stellar transaction for the requested hash');
    }
    const StellarSdk = resolveStellarSdk();
    const isAccount = (account: string | undefined) => Boolean(account && (
      StellarSdk.StrKey.isValidEd25519PublicKey(account) || StellarSdk.StrKey.isValidMed25519PublicKey(account)
    ));
    let cursor = '';
    const transfers: ColdPaymentTransfer[] = [];
    const seen = new Set<string>();
    while (seen.size < tx.operation_count) {
      const page = await this.readColdHorizon<{ _embedded: { records: RawHorizonOperation[] } }>(
        `transactions/${txHash}/operations?order=asc&limit=200${cursor ? `&cursor=${cursor}` : ''}`
      );
      if (!Array.isArray(page._embedded?.records) || !page._embedded.records.length) {
        throw new Error('Incomplete Stellar transaction operations');
      }
      for (const op of page._embedded.records) {
        if (op.transaction_hash !== txHash || op.transaction_successful !== true ||
            typeof op.type !== 'string' || !op.type ||
            typeof op.id !== 'string' || !/^[1-9]\d*$/.test(op.id) ||
            op.id !== op.paging_token || seen.has(op.id)) {
          throw new Error('Malformed or unrelated Stellar transaction operation');
        }
        seen.add(op.id);
        cursor = op.paging_token;
        if (op.type !== 'payment') continue;
        // Horizon's payment from/to (including muxed addresses) identify the actual payment,
        // whereas the transaction source may only have paid fees or supplied the default source.
        const source = op.from_muxed ?? op.from;
        const recipient = op.to_muxed ?? op.to;
        const amount = typeof op.amount === 'string' ? /^(0|[1-9]\d*)\.(\d{7})$/.exec(op.amount) : null;
        const asset = op.asset_type === 'native' ? 'native' :
          (op.asset_type === 'credit_alphanum4' || op.asset_type === 'credit_alphanum12') &&
          op.asset_code && (op.asset_code !== 'USDC' || op.asset_type === 'credit_alphanum4') &&
          op.asset_issuer && StellarSdk.StrKey.isValidEd25519PublicKey(op.asset_issuer)
            ? `${op.asset_code}:${op.asset_issuer}` : null;
        if (!source || !recipient || !isAccount(source) || !isAccount(recipient) || !amount || !asset) {
          throw new Error('Malformed Stellar payment operation');
        }
        const units = BigInt(amount[1] + amount[2]);
        if (units <= BigInt(0) || units > BigInt('9223372036854775807')) {
          throw new Error('Invalid Stellar payment amount');
        }
        transfers.push({ operationId: op.id, source, recipient, asset, amountUnits: units });
      }
    }
    if (seen.size !== tx.operation_count) throw new Error('Unexpected Stellar transaction operation count');
    return { network: this.coldPaymentNetwork, txHash, blockReference: String(tx.ledger), transfers };
  }

  async lookupTransaction(txHash: string): Promise<StellarHorizonTxLookupResult> {
    const tx = await this.stellarService.getTransaction(txHash);
    if (!tx) {
      return { found: false, successful: false };
    }
    if ((tx.hash ?? tx.id).toLowerCase() !== txHash.toLowerCase() || typeof tx.successful !== 'boolean') {
      throw new Error('Invalid Horizon transaction identity or status');
    }
    const rawLedger = tx.ledger_attr ?? tx.ledger;
    const ledger =
      typeof rawLedger === 'number' && Number.isSafeInteger(rawLedger) && rawLedger > 0
        ? rawLedger
        : undefined;
    return {
      found: true,
      successful: tx.successful,
      ...(ledger !== undefined ? { ledger } : {}),
    };
  }
}
