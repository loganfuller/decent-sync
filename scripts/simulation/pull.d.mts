export interface ListedShot {
  id: string;
  pulledAt: string;
  profileTitle: string | null;
  machine?: { id: string } | null;
  pendingMachine?: { id: string } | null;
}
export declare function spreadOut<T extends ListedShot>(listed: T[], per: number, tea: number): T[];
export declare function pull(options: { base: string; email: string; password: string; out: string; per?: number; tea?: number; since?: string | null }): Promise<{ listed: number; chosen: number; fetched: number }>;
