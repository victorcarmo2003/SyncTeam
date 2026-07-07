// SyncTeam — rastreamento de leases (M3.2/M3.3). Mantém o mapa de quem
// é dono de cada script para fornecer feedback visível na UI.
//
// Este módulo é puro (sem vscode, sem I/O) e testável com fakes.

/**
 * Estado conhecido de uma lease para um uuid.
 */
interface LeaseState {
  ownerClientId: string | null;
  ownerDisplayName: string | null;
}

export class LeaseTracker {
  private readonly leases = new Map<string, LeaseState>();

  constructor(private myClientId: string | null) {}

  /**
   * Atualiza o estado de uma lease quando `leaseChanged` chega.
   * `ownerClientId: null` significa "ninguém é dono, arquivo está livre".
   */
  updateLease(uuid: string, ownerClientId: string | null, ownerDisplayName: string | null): void {
    this.leases.set(uuid, { ownerClientId, ownerDisplayName });
  }

  /**
   * Retorna true se o script é meu (dono == myClientId) ou está livre (dono == null).
   * Regra otimista: se não houver lease arbitrada ainda, permite edição.
   */
  isOwnedByMe(uuid: string): boolean {
    const lease = this.leases.get(uuid);
    if (lease === undefined) {
      // Nenhuma lease foi arbitrada ainda — permite otimisticamente.
      return true;
    }
    return lease.ownerClientId === this.myClientId || lease.ownerClientId === null;
  }

  /**
   * Retorna o nome de quem é dono de um script, ou null se for eu mesmo
   * ou se a lease estiver livre. Usado para exibir mensagem de "quem está
   * editando este arquivo".
   */
  describeOwner(uuid: string): string | null {
    const lease = this.leases.get(uuid);
    if (lease === undefined) {
      // Nenhuma lease arbitrada ainda.
      return null;
    }
    if (lease.ownerClientId === this.myClientId || lease.ownerClientId === null) {
      // É meu ou está livre.
      return null;
    }
    // Retorna o nome de quem é dono (se disponível) ou o clientId.
    return lease.ownerDisplayName ?? `cliente ${lease.ownerClientId}`;
  }

  /**
   * Retorna o estado bruto de uma lease, se quiser inspecionar manualmente.
   */
  getLease(uuid: string): LeaseState | undefined {
    return this.leases.get(uuid);
  }
}
