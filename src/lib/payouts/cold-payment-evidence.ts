/** Exact chain-native evidence for one finalized USDC payment, not a transaction summary. */
export interface ColdPaymentTransfer {
  operationId: string;
  source: string;
  recipient: string;
  asset: string;
  amountUnits: bigint;
}

export interface ColdPaymentEvidence {
  network: string;
  txHash: string;
  blockReference: string;
  transfers: ColdPaymentTransfer[];
}

export function normalizeColdTxHash(chain: 'stellar' | 'arbitrum' | 'base', value: string): string {
  const hash = value.trim().toLowerCase();
  const pattern = chain === 'stellar' ? /^[\da-f]{64}$/ : /^0x[\da-f]{64}$/;
  if (!pattern.test(hash)) throw new Error('A canonical on-chain txHash is required');
  return hash;
}

export function selectColdPaymentTransfer(params: {
  evidence: ColdPaymentEvidence;
  txHash: string;
  network: string;
  stellar: boolean;
  source: string;
  recipient: string;
  asset: string;
  amountUnits: bigint;
  operationId?: string;
}): ColdPaymentTransfer {
  const { evidence, stellar } = params;
  const sameAddress = (left: string, right: string) =>
    stellar ? left === right : left.toLowerCase() === right.toLowerCase();
  const validAddress = (value: string) =>
    stellar ? /^[GM][A-Z2-7]{55,68}$/.test(value) : /^0x[\da-f]{40}$/i.test(value);
  if (evidence.network !== params.network || evidence.txHash !== params.txHash || !evidence.blockReference) {
    throw new Error('Cold payment proof does not match the requested transaction or network');
  }
  if (!validAddress(params.source) || !validAddress(params.recipient)) {
    throw new Error('Cold payout treasury source or recipient address is invalid');
  }
  const ids = new Set<string>();
  for (const transfer of evidence.transfers) {
    if (!/^(0|[1-9]\d*)$/.test(transfer.operationId) || ids.has(transfer.operationId) ||
        !validAddress(transfer.source) || !validAddress(transfer.recipient) ||
        !transfer.asset || typeof transfer.amountUnits !== 'bigint' || transfer.amountUnits < BigInt(0)) {
      throw new Error('Malformed or duplicate cold transfer metadata');
    }
    ids.add(transfer.operationId);
  }
  let candidates = evidence.transfers;
  if (params.operationId !== undefined) {
    candidates = candidates.filter((transfer) => transfer.operationId === params.operationId);
  }
  if (!candidates.length) throw new Error('Transaction contains no attributable USDC transfer events');
  candidates = candidates.filter((transfer) => sameAddress(transfer.source, params.source));
  if (!candidates.length) throw new Error('Transfer source does not match the expected cold treasury');
  candidates = candidates.filter((transfer) => sameAddress(transfer.recipient, params.recipient));
  if (!candidates.length) throw new Error('Transfer recipient does not match the expected cold payout');
  candidates = candidates.filter((transfer) => sameAddress(transfer.asset, params.asset));
  if (!candidates.length) throw new Error('Transfer does not match expected USDC asset');
  candidates = candidates.filter((transfer) => transfer.amountUnits === params.amountUnits);
  if (!candidates.length) throw new Error('Transfer does not match expected chain token units');
  if (candidates.length !== 1) throw new Error('Ambiguous cold payment: specify an exact operationId');
  return candidates[0];
}
