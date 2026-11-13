import { z } from 'zod';
export const spaceCleanupPolicySchema = z.object({ enabled: z.boolean(), idleDays: z.number().int().min(1).max(365), intervalHours: z.number().int().min(1).max(168) }).strict();
export type SpaceCleanupPolicy = z.infer<typeof spaceCleanupPolicySchema>;
export interface WorkspaceActivity { path: string; sessionId: string; title: string; updatedAt: string; active: boolean; managed: boolean }
export interface SpaceCleanupItem {
  path: string; project: string; branch: string; bytes: number | null; sizeError?: string;
  linked: boolean; managed: boolean; lastUsedAt: string; sessions: number; activeSessions: number;
  sessionDetails: { id: string; title: string; active: boolean; updatedAt: string }[];
  eligible: boolean; reason: string; revision: string;
}
export interface SpaceCleanupResult { path: string; deleted: boolean; message: string; bytes: number; at: string; mode: 'manual' | 'scheduled' }
export interface SpaceCleanupState {
  scanning: boolean; cleaning: boolean; scannedAt?: string; progress: number; total: number; error?: string;
  warnings: string[]; items: SpaceCleanupItem[]; policy: SpaceCleanupPolicy; nextRunAt?: string;
  history: SpaceCleanupResult[];
}
