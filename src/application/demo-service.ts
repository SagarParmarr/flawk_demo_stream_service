import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../infrastructure/config.js';
import { isTerminal, transition, type DemoRepository, type DemoSession, type Decision, type Publisher, type PublisherCredentials } from '../domain/demo.js';
import type { GoLivePort, LaravelPort, MediaPort, PublisherPort } from '../domain/ports.js';
import { hasSelectedCapacity, millisecondsToBoundary, waitForTakeover } from './takeover.js';

export class DemoError extends Error {
  constructor(public readonly code: number, message: string) { super(message); }
}

interface Runtime {
  publisher: Publisher;
  pendingPublisher: Publisher | null;
  ingest: PublisherCredentials;
  busy: boolean;
  lastHeartbeat: number;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DemoService {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly loops = new Set<string>();
  private readonly stopping = new Set<string>();
  private readonly creatingNodeSession = new Set<string>();
  private shuttingDown = false;

  constructor(
    private readonly config: Config,
    private readonly repository: DemoRepository,
    private readonly laravel: LaravelPort,
    private readonly node: GoLivePort,
    private readonly media: MediaPort,
    private readonly ffmpeg: PublisherPort,
    private readonly log: FastifyBaseLogger,
  ) {}

  async start(adaptiveSessionId: string, unitId: number, key: string, bearer: string): Promise<DemoSession> {
    if (this.shuttingDown) throw new DemoError(503, 'Demo service is restarting');
    const capture = await this.laravel.validate(adaptiveSessionId, bearer);
    if (capture.session_id !== adaptiveSessionId || capture.unit_ids.length !== 1 ||
      capture.unit_ids[0] !== unitId || !Number.isInteger(capture.owner_id)) {
      throw new DemoError(422, 'Capture session does not match the selected screen');
    }
    const existingKey = this.repository.findByIdempotencyKey(capture.owner_id, key);
    if (existingKey) {
      if (existingKey.adaptiveSessionId !== adaptiveSessionId || existingKey.unitId !== unitId) {
        throw new DemoError(409, 'Idempotency key belongs to another Demo');
      }
      return existingKey;
    }
    if (!['READY_FOR_CAPTURE', 'CAPTURING', 'COMPLETE', 'PAUSED'].includes(capture.state)) {
      throw new DemoError(409, 'Capture session is not active');
    }
    const active = this.repository.findActiveByOwner(capture.owner_id);
    if (active) {
      if (active.adaptiveSessionId === adaptiveSessionId && active.unitId === unitId) return active;
      throw new DemoError(409, 'This owner already has an active Demo');
    }
    const now = Date.now();
    const session: DemoSession = {
      id: `demo_${randomUUID()}`, ownerId: capture.owner_id, unitId,
      adaptiveSessionId, goLiveSessionId: null, playbackUrl: null,
      idempotencyKey: key, status: 'starting', operation: 'starting_publisher',
      assetType: 'default', assetId: null, decisionId: null, decisionCursor: 0,
      priority: 0, takeoverCount: 0, selectedStartedAt: null, selectedDurationSeconds: null,
      nodeStopped: false, laravelStopped: false,
      startedAt: new Date(now).toISOString(), expiresAt: new Date(now + this.config.maxDemoDurationMs).toISOString(), error: null,
    };
    try { this.repository.create(session); }
    catch {
      const concurrent = this.repository.findByIdempotencyKey(capture.owner_id, key) ?? this.repository.findActiveByOwner(capture.owner_id);
      if (concurrent?.adaptiveSessionId === adaptiveSessionId && concurrent.unitId === unitId) return concurrent;
      throw new DemoError(409, 'This owner already has an active Demo');
    }
    this.creatingNodeSession.add(session.id);
    try {
      // The bearer is needed only for these two request-scoped calls. Background
      // provisioning and recovery use service credentials, never a mobile token.
      const created = await this.node.create(unitId, bearer);
      const current = this.mustFind(session.id);
      current.goLiveSessionId = created.session.public_id;
      current.playbackUrl = created.playback_url;
      this.repository.save(current);
      if (current.status !== 'starting') return current;
      if (!this.shuttingDown) void this.provision(session.id);
      return current;
    } catch (error) {
      const current = this.repository.find(session.id);
      if (current && current.status === 'starting') {
        current.error = 'Demo could not start';
        this.repository.save(current);
        await this.stopInternal(session.id, true);
      }
      throw error;
    } finally {
      this.creatingNodeSession.delete(session.id);
      if (this.repository.find(session.id)?.status === 'stopping') void this.stopInternal(session.id, false);
    }
  }

  async get(id: string, bearer: string): Promise<DemoSession> {
    const session = this.repository.find(id);
    if (!session) throw new DemoError(404, 'Demo not found');
    const capture = await this.laravel.validate(session.adaptiveSessionId, bearer);
    if (capture.owner_id !== session.ownerId) throw new DemoError(403, 'Demo belongs to another user');
    return session;
  }

  async stop(id: string, bearer: string): Promise<DemoSession> {
    const session = await this.get(id, bearer);
    if (!isTerminal(session.status)) void this.stopInternal(id, false);
    return this.repository.find(id) ?? session;
  }

  async recover(): Promise<void> {
    for (const session of this.repository.listNonterminal()) {
      if (session.status === 'stopping' || Date.now() >= Date.parse(session.expiresAt) || !session.goLiveSessionId) {
        void this.stopInternal(session.id, session.status !== 'stopping');
      } else {
        void this.recoverOne(session.id);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // Do not stop downstream sessions here: systemd restarts the coordinator,
    // which recovers them from SQLite. Only local process groups must exit.
    await Promise.allSettled([...this.runtimes.values()].flatMap((runtime) =>
      [runtime.publisher, runtime.pendingPublisher].filter((publisher): publisher is Publisher => publisher !== null)
        .map((publisher) => publisher.stop())));
    this.runtimes.clear();
  }

  private async provision(id: string): Promise<void> {
    let cancelHeartbeat: (() => void) | undefined;
    try {
      let session = this.mustFind(id);
      if (session.status !== 'starting' || !session.goLiveSessionId) return;
      cancelHeartbeat = this.keepSessionAlive(session.goLiveSessionId, session.ownerId);
      await this.laravel.bind(session.adaptiveSessionId, session.id, session.goLiveSessionId, session.ownerId, session.unitId);
      const acquired = await this.node.acquire(session.goLiveSessionId, session.ownerId, session.unitId);
      const defaultMedia = await this.media.prepare(this.config.defaultS3Uri, 'default');
      if (this.shuttingDown) return;
      const publisher = await this.ffmpeg.start(defaultMedia.path, defaultMedia.hasAudio, defaultMedia.durationSeconds, acquired.ingest, 0);
      if (this.shuttingDown) { await publisher.stop(); return; }
      this.runtimes.set(id, { publisher, pendingPublisher: null, ingest: acquired.ingest, busy: false, lastHeartbeat: Date.now() });
      if (this.mustFind(id).status !== 'starting') { await publisher.stop(); this.runtimes.delete(id); return; }
      if (this.shuttingDown) return;
      await this.node.start(session.goLiveSessionId, session.ownerId);
      if (!publisher.alive()) throw new Error('Default publisher exited before IVS became live');
      session = transition(this.mustFind(id), 'default_live');
      session.operation = null;
      this.repository.save(session);
      await this.reportContent(session);
      this.runLoop(id);
    } catch (error) {
      if (this.shuttingDown) return;
      this.log.error({ demoId: id, error: safeError(error) }, 'Demo startup failed');
      const session = this.repository.find(id);
      if (session && session.status !== 'stopped') {
        session.error = 'Demo could not start';
        this.repository.save(session);
        await this.stopInternal(id, true);
      }
    } finally { cancelHeartbeat?.(); }
  }

  private async recoverOne(id: string): Promise<void> {
    let session = this.mustFind(id);
    if (!session.goLiveSessionId) return;
    let cancelHeartbeat: (() => void) | undefined;
    try {
      if (session.takeoverCount >= 90) throw new Error('IVS takeover capacity exhausted');
      session.operation = 'recovering';
      this.repository.save(session);
      cancelHeartbeat = this.keepSessionAlive(session.goLiveSessionId, session.ownerId);
      // A restart may happen after Node creation but before Laravel binding.
      await this.laravel.bind(session.adaptiveSessionId, session.id, session.goLiveSessionId, session.ownerId, session.unitId);
      const feed = await this.laravel.decisions(session.adaptiveSessionId, session.decisionCursor);
      if (feed.owner_id !== session.ownerId || feed.unit_ids.length !== 1 || feed.unit_ids[0] !== session.unitId || feed.state === 'STOPPED') {
        throw new Error('Capture session no longer matches Demo');
      }
      const acquired = await this.node.acquire(session.goLiveSessionId, session.ownerId, session.unitId);
      const source = await this.media.prepare(this.config.defaultS3Uri, 'default');
      if (this.shuttingDown) return;
      const priority = session.priority + 1;
      const baseline = await this.node.status(session.goLiveSessionId, session.ownerId);
      const publisher = await this.ffmpeg.start(source.path, source.hasAudio, source.durationSeconds, acquired.ingest, priority);
      if (this.shuttingDown) { await publisher.stop(); return; }
      this.runtimes.set(id, { publisher, pendingPublisher: null, ingest: acquired.ingest, busy: false, lastHeartbeat: Date.now() });
      if (this.shuttingDown) return;
      if (baseline.is_live) {
        await waitForTakeover(publisher, () => this.node.status(session.goLiveSessionId!, session.ownerId), baseline);
      } else {
        await this.node.start(session.goLiveSessionId, session.ownerId);
      }
      if (!publisher.alive()) throw new Error('Recovery publisher exited');
      session = this.mustFind(id);
      session.priority = priority;
      session.takeoverCount += 1;
      session.assetType = 'default';
      session.assetId = null;
      session.decisionId = null;
      session.selectedStartedAt = null;
      session.selectedDurationSeconds = null;
      session = transition(session, 'default_live');
      session.operation = null;
      this.repository.save(session);
      await this.reportContent(session);
      this.runLoop(id);
    } catch (error) {
      if (this.shuttingDown) return;
      this.log.error({ demoId: id, error: safeError(error) }, 'Demo recovery failed');
      const failed = this.repository.find(id);
      if (failed) { failed.error = 'Demo could not recover'; this.repository.save(failed); }
      await this.stopInternal(id, true);
    } finally { cancelHeartbeat?.(); }
  }

  private keepSessionAlive(goLiveId: string, ownerId: number): () => void {
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void this.node.heartbeat(goLiveId, ownerId)
        .catch((error) => this.log.warn({ error: safeError(error) }, 'Demo provisioning heartbeat failed'))
        .finally(() => { inFlight = false; });
    }, this.config.heartbeatIntervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private runLoop(id: string): void {
    if (this.loops.has(id)) return;
    this.loops.add(id);
    void (async () => {
      try {
        while (!this.shuttingDown) {
          const session = this.mustFind(id);
          if (!['default_live', 'selected_live'].includes(session.status)) return;
          if (Date.now() >= Date.parse(session.expiresAt)) { await this.stopInternal(id, false); return; }
          const runtime = this.runtimes.get(id);
          if (!runtime?.publisher.alive()) { await this.stopInternal(id, true); return; }
          try {
            if (Date.now() - runtime.lastHeartbeat >= this.config.heartbeatIntervalMs && session.goLiveSessionId) {
              await this.node.heartbeat(session.goLiveSessionId, session.ownerId);
              runtime.lastHeartbeat = Date.now();
            }
            if (session.status === 'selected_live') {
              const started = session.selectedStartedAt;
              const duration = session.selectedDurationSeconds;
              if (started && duration && millisecondsToBoundary(started, duration) <= this.config.pollIntervalMs) {
                await this.restoreDefault(id);
              }
            } else {
              await this.pollDecisions(id);
            }
          } catch (error) {
            this.log.warn({ demoId: id, error: safeError(error) }, 'Demo loop iteration failed');
          }
          await wait(this.config.pollIntervalMs);
        }
      } finally { this.loops.delete(id); }
    })();
  }

  private async pollDecisions(id: string): Promise<void> {
    let session = this.mustFind(id);
    const feed = await this.laravel.decisions(session.adaptiveSessionId, session.decisionCursor);
    if (feed.owner_id !== session.ownerId || feed.unit_ids.length !== 1 || feed.unit_ids[0] !== session.unitId) {
      throw new Error('Decision feed identity changed');
    }
    if (feed.state === 'STOPPED') { await this.stopInternal(id, false); return; }
    for (const decision of feed.decisions) {
      session = this.mustFind(id);
      if (session.status !== 'default_live') return;
      if (decision.cycle_number <= session.decisionCursor) continue;
      // Advance before attempting takeover. A crash may skip a decision, but cannot replay it.
      session.decisionCursor = decision.cycle_number;
      this.repository.save(session);
      if (!this.validDecision(decision, session)) continue;
      await this.switchSelected(id, decision);
      return;
    }
  }

  private validDecision(decision: Decision, session: DemoSession): boolean {
    if (decision.result !== 'SELECT_ASSET' || !decision.asset || !hasSelectedCapacity(session.takeoverCount)) return false;
    if (decision.expires_at && Date.parse(decision.expires_at) <= Date.now()) return false;
    if (decision.asset.id === session.assetId) return false;
    return /^s3:\/\/[^/]+\/.+\.mp4$/i.test(decision.asset.s3_uri);
  }

  private async switchSelected(id: string, decision: Decision): Promise<void> {
    const session = this.mustFind(id);
    if (!decision.asset) return;
    session.operation = 'switching_selected';
    this.repository.save(session);
    try {
      const media = await this.media.prepare(decision.asset.s3_uri, decision.decision_id);
      await this.takeover(id, media, 'selected', decision.asset.id, decision.decision_id);
    } finally {
      const current = this.repository.find(id);
      if (current?.operation === 'switching_selected') { current.operation = null; this.repository.save(current); }
    }
  }

  private async restoreDefault(id: string): Promise<void> {
    const session = this.mustFind(id);
    session.operation = 'restoring_default';
    this.repository.save(session);
    try {
      const media = await this.media.prepare(this.config.defaultS3Uri, 'default');
      await this.takeover(id, media, 'default', null, null);
    } finally {
      const current = this.repository.find(id);
      if (current?.operation === 'restoring_default') { current.operation = null; this.repository.save(current); }
    }
  }

  private async takeover(id: string, media: { path: string; hasAudio: boolean; durationSeconds: number },
    type: 'default' | 'selected', assetId: number | null, decisionId: string | null): Promise<void> {
    const current = this.mustFind(id);
    const runtime = this.runtimes.get(id);
    if (!runtime || !current.goLiveSessionId || runtime.busy) throw new Error('Publisher is unavailable');
    runtime.busy = true;
    let replacement: Publisher | null = null;
    try {
      const baseline = await this.node.status(current.goLiveSessionId, current.ownerId);
      if (!baseline.is_live) throw new Error('IVS stream is not live');
      replacement = await this.ffmpeg.start(media.path, media.hasAudio, media.durationSeconds, runtime.ingest, current.priority + 1);
      if (this.shuttingDown) { await replacement.stop(); return; }
      runtime.pendingPublisher = replacement;
      // IVS may keep the old RTMPS connection open. Its takeover event is the authority.
      await waitForTakeover(replacement, () => this.node.status(current.goLiveSessionId!, current.ownerId), baseline);
      const latest = this.mustFind(id);
      if (!['default_live', 'selected_live'].includes(latest.status)) { await replacement.stop(); return; }
      const previous = runtime.publisher;
      runtime.publisher = replacement;
      latest.priority += 1;
      latest.takeoverCount += 1;
      latest.assetType = type;
      latest.assetId = assetId;
      latest.decisionId = decisionId;
      latest.selectedStartedAt = type === 'selected' ? replacement.startedAt : null;
      latest.selectedDurationSeconds = type === 'selected' ? media.durationSeconds : null;
      this.repository.save(transition(latest, type === 'selected' ? 'selected_live' : 'default_live'));
      await previous.stop();
      await this.reportContent(this.mustFind(id));
    } catch (error) {
      if (replacement && replacement !== runtime.publisher) await replacement.stop();
      throw error;
    } finally { runtime.pendingPublisher = null; runtime.busy = false; }
  }

  private async reportContent(session: DemoSession): Promise<void> {
    if (!session.goLiveSessionId) return;
    try { await this.node.content(session.goLiveSessionId, session.ownerId, session.assetType, session.assetId, session.takeoverCount + 1); }
    catch (error) { this.log.warn({ demoId: session.id, error: safeError(error) }, 'Node content update failed'); }
  }

  private async stopInternal(id: string, failed: boolean): Promise<void> {
    if (this.stopping.has(id)) return;
    this.stopping.add(id);
    try {
      let session = this.mustFind(id);
      if (isTerminal(session.status)) return;
      session = transition(session, 'stopping');
      session.operation = null;
      this.repository.save(session);
      const runtime = this.runtimes.get(id);
      if (runtime) {
        await Promise.all([runtime.publisher.stop(), runtime.pendingPublisher?.stop()]);
        this.runtimes.delete(id);
      }
      if (session.goLiveSessionId && !session.nodeStopped) {
        try { await this.node.stop(session.goLiveSessionId, session.ownerId); session.nodeStopped = true; this.repository.save(session); }
        catch (error) { this.log.warn({ demoId: id, error: safeError(error) }, 'Node stop will retry'); }
      } else if (!session.goLiveSessionId && !this.creatingNodeSession.has(id)) {
        session.nodeStopped = true;
        this.repository.save(session);
      }
      if (!session.laravelStopped) {
        try { await this.laravel.stop(session.adaptiveSessionId); session.laravelStopped = true; this.repository.save(session); }
        catch (error) { this.log.warn({ demoId: id, error: safeError(error) }, 'Laravel stop will retry'); }
      }
      if (session.nodeStopped && session.laravelStopped) {
        session = transition(session, failed || Boolean(session.error) ? 'failed' : 'stopped');
        this.repository.save(session);
      } else {
        setTimeout(() => void this.stopInternal(id, failed), 5000).unref();
      }
    } finally { this.stopping.delete(id); }
  }

  private mustFind(id: string): DemoSession {
    const session = this.repository.find(id);
    if (!session) throw new Error(`Demo ${id} disappeared`);
    return session;
  }
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.name;
  return 'UnknownError';
}
