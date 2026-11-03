import { parseRollupAddress } from './wallet.ts';

export interface DepositFeeSchedule { fixedSats: number; bps: number }
export interface DepositFee extends DepositFeeSchedule { address: string }

/** An asset deposit's dust-sized BTC carrier is free; a bigger one pays the whole fee, or wrapping BTC around an asset unit would shield it fee-free. */
export const CARRIER_FREE_SATS = 330;
const FULL_BPS = 10_000;
const whole = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

export function depositFeeOf(fee: DepositFeeSchedule | undefined, depositSats: bigint): bigint {
 if (!fee) return 0n;
 const full = BigInt(FULL_BPS), share = (depositSats * BigInt(fee.bps) + full - 1n) / full, floor = BigInt(fee.fixedSats);
 return share > floor ? share : floor;
}
export const carrierFeeOf = (fee: DepositFeeSchedule | undefined, carrierSats: bigint): bigint => carrierSats > BigInt(CARRIER_FREE_SATS) ? depositFeeOf(fee, carrierSats) : 0n;
export const acceptsDepositFee = (advertised: DepositFeeSchedule | undefined, accepted: DepositFeeSchedule | undefined): boolean =>
 (advertised?.fixedSats ?? 0) <= (accepted?.fixedSats ?? 0) && (advertised?.bps ?? 0) <= (accepted?.bps ?? 0);
export const maxDepositFeeOf = (a: DepositFeeSchedule | undefined, b: DepositFeeSchedule | undefined): DepositFeeSchedule | undefined =>
 a || b ? { fixedSats: Math.max(a?.fixedSats ?? 0, b?.fixedSats ?? 0), bps: Math.max(a?.bps ?? 0, b?.bps ?? 0) } : undefined;
/** A ceiling a wallet stored or was given, by parseDepositFee's number rules; zero is a valid ceiling, accepting no fee. */
export function parseDepositFeeSchedule(value: unknown): DepositFeeSchedule | undefined {
 const { fixedSats, bps } = (value ?? {}) as { fixedSats?: unknown; bps?: unknown };
 return whole(fixedSats) && whole(bps) && bps <= FULL_BPS ? { fixedSats, bps } : undefined;
}
/** Anything malformed, over 100% or zero reads as no fee: a garbled /status must never throw into its caller. */
export function parseDepositFee(value: unknown): DepositFee | undefined {
 const schedule = parseDepositFeeSchedule(value), { address } = (value ?? {}) as { address?: unknown };
 if (!schedule || !(schedule.fixedSats || schedule.bps) || typeof address !== 'string') return undefined;
 try { parseRollupAddress(address); } catch { return undefined; }
 return { ...schedule, address };
}
