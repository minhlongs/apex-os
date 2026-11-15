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

interface RawHorizonSubmitResponse {
  hash?: string;
  id?: string;
  successful?: boolean;
}

export class HorizonStellarBroadcastTransport implements StellarBroadcastTransport {
  private readonly network: StellarNetwork;
  private readonly usdcIssuer: string;
  private readonly feeStroops: number;
  private readonly stellarService: StellarService;
  private readonly horizonServer: StellarSdkTypes.Horizon.Server;

  constructor(options?: HorizonStellarBroadcastTransportOptions) {
    const StellarSdk = resolveStellarSdk();
    this.network = resolveStellarNetwork(options?.network);
    const defaultIssuer =
      this.network === StellarNetwork.MAINNET
        ? CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER
        : CANONICAL_STELLAR_TESTNET_USDC_ISSUER;
    const candidateIssuer =
      options?.usdcIssuer ?? process.env.STELLAR_USDC_ISSUER ?? defaultIssuer;
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

    const result = (await this.horizonServer.submitTransaction(
      parsedTx
    )) as unknown as RawHorizonSubmitResponse;
    const txHash = (result.hash ?? result.id ?? actualHash).toLowerCase();

    return {
      txHash,
      confirmed: result.successful === true,
    };
  }

  async lookupTransaction(txHash: string): Promise<StellarHorizonTxLookupResult> {
    const tx = await this.stellarService.getTransaction(txHash);
    if (!tx) {
      return { found: false, successful: false };
    }
    return {
      found: true,
      successful: tx.successful === true,
    };
  }
}
