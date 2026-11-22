import type { Clock } from "../clock/index.ts";
import { CLOCK_DIVERGENCE_MS, LEASE_MS, RENEW_AFTER_MS } from "./types.ts";
import type { PublicationProof } from "./types.ts";

export interface LeaseStart {
  wall: number;
  monotonic: number;
}

export class PublicationWindow {
  private lease?: { proof: PublicationProof; peerBinding: string; started: LeaseStart };

  constructor(
    private readonly clock: Clock,
    private readonly monotonicMs = () => performance.now(),
  ) {}

  start(): LeaseStart {
    return { wall: this.clock.wallMs(), monotonic: this.monotonicMs() };
  }

  elapsed(started: LeaseStart): number {
    const mono = this.monotonicMs() - started.monotonic;
    const wall = this.clock.wallMs() - started.wall;
    if (!(mono >= 0 && wall >= 0) || Math.abs(mono - wall) > CLOCK_DIVERGENCE_MS) return Infinity;
    return Math.max(mono, wall);
  }

  install(proof: PublicationProof, peerBinding: string, started: LeaseStart): void {
    if (this.elapsed(started) < LEASE_MS) this.lease = { proof, peerBinding, started };
  }

  private age(proof: PublicationProof, peerBinding: string): number {
    const lease = this.lease;
    if (!lease || lease.proof.householdId !== proof.householdId || lease.proof.holderHostId !== proof.holderHostId
      || lease.proof.epoch !== proof.epoch || lease.proof.grantId !== proof.grantId || lease.peerBinding !== peerBinding) {
      return Infinity;
    }
    const elapsed = this.elapsed(lease.started);
    if (!(elapsed < LEASE_MS)) this.clear();
    return elapsed;
  }

  valid(proof: PublicationProof, peerBinding: string): boolean {
    return this.age(proof, peerBinding) < LEASE_MS;
  }

  renewalDue(proof: PublicationProof, peerBinding: string): boolean {
    return this.age(proof, peerBinding) >= RENEW_AFTER_MS;
  }

  clear(): void {
    this.lease = undefined;
  }
}
