/** @jest-environment node */

import type * as StellarSdkTypes from '@stellar/stellar-sdk';
import { ledgerUnitsToChainUnits } from '@/lib/ledger/units';
import { HorizonStellarBroadcastTransport } from '@/lib/payouts/stellar-horizon-transport';
import { fromStellarStroops, StellarNetwork } from '@/lib/payouts/stellar-service';

// Match the production fallback to Node's loader for the SDK's ESM dependencies in Jest.
const StellarSdk = process.getBuiltinModule('node:module').createRequire(__filename)(
  '@stellar/stellar-sdk'
) as typeof StellarSdkTypes;
const circleIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
// Public account encodings only; no keypair or signing material is needed.
const source = StellarSdk.StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 41));
const destination = StellarSdk.StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 42));

const boundaries = [
  { boundary: 'exact $10 minimum', ledgerUnits: 1_000_000_000, dust: 0, stroops: 100_000_000, amount: '10.0000000' },
  { boundary: 'one ledger unit above minimum', ledgerUnits: 1_000_000_001, dust: 1, stroops: 100_000_000, amount: '10.0000000' },
  { boundary: 'one ledger unit below the next quantum', ledgerUnits: 1_000_000_009, dust: 9, stroops: 100_000_000, amount: '10.0000000' },
  { boundary: 'one full Stellar quantum above minimum', ledgerUnits: 1_000_000_010, dust: 0, stroops: 100_000_001, amount: '10.0000001' },
];

describe('G16.4 unsigned Stellar USDC payment precision', () => {
  it.each(boundaries)('encodes $boundary without moving dust into the payment', async (expected) => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network disabled in this fixture'));
    try {
      const transport = new HorizonStellarBroadcastTransport({
        network: StellarNetwork.MAINNET,
        horizonUrl: 'https://stellar-wire.invalid',
        usdcIssuer: circleIssuer,
      });
      const { chainUnits: amountStroops, residualDust1e8 } = ledgerUnitsToChainUnits(
        BigInt(expected.ledgerUnits), 'stellar'
      );
      expect(residualDust1e8).toBe(BigInt(expected.dust));
      expect(amountStroops).toBe(BigInt(expected.stroops));
      const amountFormatted7 = fromStellarStroops(amountStroops);
      expect(amountFormatted7).toBe(expected.amount);

      const built = await transport.buildUnsignedUsdcPayment({
        fromAccount: source,
        recipientAddress: destination,
        stellarSequence: '12345',
        amountStroops,
        amountFormatted7,
        timeboundsMaxUnix: 1_794_000_180,
      });
      expect(built.amountFormatted7).toBe(expected.amount);

      const decoded = StellarSdk.TransactionBuilder.fromXDR(built.unsignedEnvelopeXdr, StellarSdk.Networks.PUBLIC);
      if (!(decoded instanceof StellarSdk.Transaction)) throw new Error('Expected a Stellar transaction envelope');
      expect(decoded.source).toBe(source);
      expect(decoded.signatures).toHaveLength(0);
      expect(decoded.operations).toHaveLength(1);
      const [payment] = decoded.operations;
      if (!payment || payment.type !== 'payment') throw new Error('Expected a Stellar payment operation');
      expect(payment.source ?? decoded.source).toBe(source);
      expect(payment.destination).toBe(destination);
      expect(payment.asset.isNative()).toBe(false);
      expect(payment.asset.getCode()).toBe('USDC');
      expect(payment.asset.getIssuer()).toBe(circleIssuer);

      const envelope = StellarSdk.xdr.TransactionEnvelope.fromXDR(built.unsignedEnvelopeXdr, 'base64');
      if (envelope.type !== 'envelopeTypeTx') throw new Error('Expected a v1 Stellar envelope');
      const [wirePayment] = envelope.v1.tx.operations;
      if (wirePayment?.body.type !== 'payment') throw new Error('Expected an XDR payment operation');
      const wireStroops = wirePayment.body.paymentOp.amount;
      expect(wireStroops).toBe(amountStroops);
      const wireDigits = wireStroops.toString().padStart(8, '0');
      expect(`${wireDigits.slice(0, -7)}.${wireDigits.slice(-7)}`).toBe(amountFormatted7);
      expect(wireStroops * BigInt(10) + residualDust1e8).toBe(BigInt(expected.ledgerUnits));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
