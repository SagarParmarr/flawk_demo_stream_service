export type DemoStatus = 'starting' | 'default_live' | 'selected_live' | 'stopping' | 'stopped' | 'failed';
export type DemoOperation = 'starting_publisher' | 'switching_selected' | 'restoring_default' | 'recovering' | null;
export type AssetType = 'default' | 'selected';

export interface DemoSession {
  id: string;
  ownerId: number;
  unitId: number;
  adaptiveSessionId: string;
  goLiveSessionId: string | null;
  playbackUrl: string | null;
  idempotencyKey: string;
  status: DemoStatus;
  operation: DemoOperation;
  assetType: AssetType;
  assetId: number | null;
  decisionId: string | null;
  decisionCursor: number;
  priority: number;
  takeoverCount: number;
  selectedStartedAt: string | null;
  selectedDurationSeconds: number | null;
  selectedExpiresAt: string | null;
  presenceExpiresAt: string | null;
  nodeStopped: boolean;
  laravelStopped: boolean;
  startedAt: string;
  expiresAt: string;
  error: string | null;
}

export interface Decision {
  decision_id: string;
  cycle_number: number;
  result: 'SELECT_ASSET' | 'NO_DECISION';
  expires_at: string | null;
  asset: { id: number; name: string; s3_uri: string } | null;
}

export interface CaptureSession {
  session_id: string;
  owner_id: number;
  unit_ids: number[];
  state: string;
}

export interface PublisherCredentials {
  ingest_server: string;
  stream_key: string;
}

export interface GoLiveSession {
  public_id: string;
  playback_url: string;
}

export interface Publisher {
  readonly pid: number;
  readonly startedAt: string;
  readonly durationSeconds: number | null;
  readonly exit: Promise<number | null>;
  stop(): Promise<void>;
  alive(): boolean;
}

export interface DemoRepository {
  find(id: string): DemoSession | null;
  findActiveByOwner(ownerId: number): DemoSession | null;
  findByIdempotencyKey(ownerId: number, key: string): DemoSession | null;
  listNonterminal(): DemoSession[];
  create(session: DemoSession): void;
  save(session: DemoSession): void;
}

export const isTerminal = (status: DemoStatus): boolean => status === 'stopped' || status === 'failed';

const transitions: Record<DemoStatus, DemoStatus[]> = {
  starting: ['default_live', 'stopping', 'failed'],
  default_live: ['selected_live', 'stopping', 'failed'],
  selected_live: ['default_live', 'stopping', 'failed'],
  stopping: ['stopped', 'failed'],
  stopped: [],
  failed: ['stopping'],
};

export function transition(session: DemoSession, next: DemoStatus): DemoSession {
  if (session.status !== next && !transitions[session.status].includes(next)) {
    throw new Error(`Invalid Demo transition: ${session.status} to ${next}`);
  }
  return { ...session, status: next };
}

export function publicDemo(session: DemoSession) {
  return {
    id: session.id,
    unit_ids: [session.unitId],
    adaptive_session_id: session.adaptiveSessionId,
    go_live_session_id: session.goLiveSessionId,
    status: session.status,
    operation: session.operation,
    current_asset: { type: session.assetType, decision_id: session.decisionId, asset_id: session.assetId },
    playback_url: session.playbackUrl,
    started_at: session.startedAt,
    expires_at: session.expiresAt,
    selected_expires_at: session.selectedExpiresAt,
    presence_expires_at: session.presenceExpiresAt,
    error: session.error,
  };
}
