import type { PreparedMedia } from '../domain/demo.js';
import { performance } from 'node:perf_hooks';
import { timed, type TimingContext } from '../observability/timing.js';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../infrastructure/config.js';
import { isTerminal, transition, type DemoRepository, type DemoSession, type Decision, type Publisher, type PublisherCredentials } from '../domain/demo.js';
import type { GoLivePort, LaravelPort, MediaPort, PublisherPort } from '../domain/ports.js';
import { abortable, hasSelectedCapacity, waitForTakeover } from './takeover.js';

export class DemoError extends Error {
  constructor(public readonly code: number, message: string) { super(message); }
}

interface Runtime {
  publisher: Publisher;
  pendingPublisher: Publisher | null;
  ingest: PublisherCredentials;
  busy: boolean;
  lastHeartbeat: number;
  lastDecisionPollCompletedAt: number | null;
  defaultMedia: PreparedMedia;
  selectedSourceUri: string | null;
  switchAbort: AbortController | null;
  switchTask: Promise<void> | null;
  restoreTask: Promise<void> | null;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DemoService {
  private readonly startupTimings = new Map<string, { start: number; startedAt: string }>();
  private readonly runtimes = new Map<string, Runtime>();
  private readonly loops = new Set<string>();
  private readonly stopping = new Set<string>();
  private readonly creatingNodeSession = new Set<string>();
  private shuttingDown = false;
  private readonly watchdogs = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly config: Config,
    private readonly repository: DemoRepository,
    private readonly laravel: LaravelPort,
    private readonly node: GoLivePort,
    private readonly media: MediaPort,
    private readonly ffmpeg: PublisherPort,
    private readonly log: FastifyBaseLogger,
    private readonly now: () => number = Date.now,
  ) {}

  async start(adaptiveSessionId: string, unitId: number, key: string, bearer: string, mobilePresenceRequired = false): Promise<DemoSession> {
    if (this.shuttingDown) throw new DemoError(503, 'Demo service is restarting');
    const requestTiming = { start: performance.now(), startedAt: new Date().toISOString() };
    const capture = await timed(this.log, 'laravel_session_validation', { adaptiveSessionId, unitId }, () => this.laravel.validate(adaptiveSessionId, bearer));
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
    const now = this.now();
    const session: DemoSession = {
      id: `demo_${randomUUID()}`, ownerId: capture.owner_id, unitId,
      adaptiveSessionId, goLiveSessionId: null, playbackUrl: null,
      idempotencyKey: key, status: 'starting', operation: 'starting_publisher',
      assetType: 'default', assetId: null, decisionId: null, decisionCursor: 0,
      priority: 0, takeoverCount: 0, selectedStartedAt: null, selectedDurationSeconds: null,
      selectedExpiresAt: null, presenceExpiresAt: mobilePresenceRequired ? new Date(now + 60_000).toISOString() : null,
      nodeStopped: false, laravelStopped: false,
      startedAt: new Date(now).toISOString(), expiresAt: new Date(now + this.config.maxDemoDurationMs).toISOString(), error: null,
    };
    try { this.repository.create(session); }
    catch {
      const concurrent = this.repository.findByIdempotencyKey(capture.owner_id, key) ?? this.repository.findActiveByOwner(capture.owner_id);
      if (concurrent?.adaptiveSessionId === adaptiveSessionId && concurrent.unitId === unitId) return concurrent;
      throw new DemoError(409, 'This owner already has an active Demo');
    }
    this.startupTimings.set(session.id, requestTiming);
    this.watchDeadlines(session.id);
    this.creatingNodeSession.add(session.id);
    try {
      // The bearer is needed only for these two request-scoped calls. Background
      // provisioning and recovery use service credentials, never a mobile token.
      const created = await timed(this.log, 'go_live_session_create', this.context(session.id), () => this.node.create(unitId, bearer));
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

  async heartbeat(id: string, bearer: string): Promise<DemoSession> {
    await this.get(id, bearer);
    // Re-read after authorization: Stop or lease expiry may have won that race.
    const session = this.mustFind(id);
    if (isTerminal(session.status) || session.status === 'stopping') return session;
    if (session.presenceExpiresAt) {
      if (this.now() >= Date.parse(session.presenceExpiresAt)) {
        void this.stopInternal(id, false, 'presence_expired');
        return this.mustFind(id);
      }
      session.presenceExpiresAt = new Date(this.now() + 60_000).toISOString();
      this.repository.save(session);
    }
    return session;
  }

  async recover(): Promise<void> {
    for (const session of this.repository.listNonterminal()) {
      this.watchDeadlines(session.id);
      if ((session.presenceExpiresAt && this.now() >= Date.parse(session.presenceExpiresAt)) || session.status === 'stopping' || this.now() >= Date.parse(session.expiresAt) || !session.goLiveSessionId) {
        void this.stopInternal(session.id, session.status !== 'stopping');
      } else {
        void this.recoverOne(session.id);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.watchdogs.values()) clearInterval(timer);
    this.watchdogs.clear();
    for (const runtime of this.runtimes.values()) runtime.switchAbort?.abort();
    // Do not stop downstream sessions here: systemd restarts the coordinator,
    // which recovers them from SQLite. Only local process groups must exit.
    await Promise.allSettled([...this.runtimes.values()].flatMap((runtime) =>
      [runtime.publisher, runtime.pendingPublisher].filter((publisher): publisher is Publisher => publisher !== null)
        .map((publisher) => publisher.stop())));
    this.runtimes.clear();
    this.startupTimings.clear();
  }

  private async provision(id: string): Promise<void> {
    await timed(this.log, 'startup_pipeline', this.context(id), async () => {
      if (!await this.provisionWork(id)) throw new Error('Startup did not reach live');
    }).catch(() => undefined);
  }

  private async provisionWork(id: string): Promise<boolean> {
    let cancelHeartbeat: (() => void) | undefined;
    try {
      let session = this.mustFind(id);
      if (session.status !== 'starting' || !session.goLiveSessionId) return false;
      cancelHeartbeat = this.keepSessionAlive(session.goLiveSessionId, session.ownerId);
      await timed(this.log, 'laravel_session_bind', this.context(id), () => this.laravel.bind(session.adaptiveSessionId, session.id, session.goLiveSessionId!, session.ownerId, session.unitId));
      const acquired = await timed(this.log, 'go_live_publisher_acquire', this.context(id), () => this.node.acquire(session.goLiveSessionId!, session.ownerId, session.unitId));
      const defaultMedia = await timed(this.log, 'default_media_prepare', this.context(id), () => this.media.prepare(this.config.defaultS3Uri, 'default', { ...this.context(id), assetType: 'default' }));
      if (this.shuttingDown || this.mustFind(id).status !== 'starting') return false;
      const publisher = await timed(this.log, 'ffmpeg_spawn', { ...this.context(id), assetType: 'default' }, () => this.ffmpeg.start(defaultMedia.path, defaultMedia.hasAudio, defaultMedia.durationSeconds, acquired.ingest, 0, { ...this.context(id), assetType: 'default' }, defaultMedia.publishMode));
      if (this.shuttingDown) { await publisher.stop(); return false; }
      this.runtimes.set(id, { publisher, pendingPublisher: null, ingest: acquired.ingest, busy: false, lastHeartbeat: this.now(), lastDecisionPollCompletedAt: null, defaultMedia, selectedSourceUri: null, switchAbort: null, switchTask: null, restoreTask: null });
      if (this.mustFind(id).status !== 'starting') { await publisher.stop(); this.runtimes.delete(id); return false; }
      if (this.shuttingDown) return false;
      await timed(this.log, 'ivs_initial_live_confirmation', this.context(id), () => this.node.start(session.goLiveSessionId!, session.ownerId));
      if (!publisher.alive()) throw new Error('Default publisher exited before IVS became live');
      if (this.mustFind(id).status !== 'starting') { await publisher.stop(); return false; }
      session = transition(this.mustFind(id), 'default_live');
      session.operation = null;
      this.repository.save(session);
      const timing = this.startupTimings.get(id);
      if (timing) {
        this.log.info?.({ ...this.context(id), event: 'demo_timing', stage: 'session_request_to_ivs_live', outcome: 'completed',
          startedAt: timing.startedAt, endedAt: new Date().toISOString(), durationMs: Math.round((performance.now() - timing.start) * 100) / 100 }, 'Demo initial IVS stream confirmed');
        this.startupTimings.delete(id);
      }
      await this.reportContent(session);
      this.runLoop(id);
      return true;
    } catch (error) {
      if (this.shuttingDown) return false;
      this.log.error({ demoId: id, error: safeError(error) }, 'Demo startup failed');
      const session = this.repository.find(id);
      if (session && session.status !== 'stopped') {
        session.error = 'Demo could not start';
        this.repository.save(session);
        await this.stopInternal(id, true);
      }
      return false;
    } finally { cancelHeartbeat?.(); }
  }

  private async recoverOne(id: string): Promise<void> {
    await timed(this.log, 'recovery_pipeline', this.context(id), async () => {
      if (!await this.recoverOneWork(id)) throw new Error('Recovery did not reach live');
    }).catch(() => undefined);
  }

  private async recoverOneWork(id: string): Promise<boolean> {
    let session = this.mustFind(id);
    if (!session.goLiveSessionId) return false;
    let cancelHeartbeat: (() => void) | undefined;
    try {
      if (session.takeoverCount >= 90) throw new Error('IVS takeover capacity exhausted');
      session.operation = 'recovering';
      session.selectedExpiresAt = null;
      this.repository.save(session);
      cancelHeartbeat = this.keepSessionAlive(session.goLiveSessionId, session.ownerId);
      // A restart may happen after Node creation but before Laravel binding.
      await timed(this.log, 'laravel_session_bind', this.context(id), () => this.laravel.bind(session.adaptiveSessionId, session.id, session.goLiveSessionId!, session.ownerId, session.unitId));
      const feed = await timed(this.log, 'laravel_decision_poll', this.context(id), () => this.laravel.decisions(session.adaptiveSessionId, session.decisionCursor), 'debug');
      if (feed.owner_id !== session.ownerId || feed.unit_ids.length !== 1 || feed.unit_ids[0] !== session.unitId || feed.state === 'STOPPED') {
        throw new Error('Capture session no longer matches Demo');
      }
      const acquired = await timed(this.log, 'go_live_publisher_acquire', this.context(id), () => this.node.acquire(session.goLiveSessionId!, session.ownerId, session.unitId));
      const source = await timed(this.log, 'default_media_prepare', this.context(id), () => this.media.prepare(this.config.defaultS3Uri, 'default', { ...this.context(id), assetType: 'default' }));
      if (this.shuttingDown || !['starting', 'default_live', 'selected_live'].includes(this.mustFind(id).status)) return false;
      const priority = session.priority + 1;
      const baseline = await timed(this.log, 'ivs_status_baseline', this.context(id), () => this.node.status(session.goLiveSessionId!, session.ownerId));
      const publisher = await timed(this.log, 'ffmpeg_spawn', { ...this.context(id), assetType: 'default' }, () => this.ffmpeg.start(source.path, source.hasAudio, source.durationSeconds, acquired.ingest, priority, { ...this.context(id), assetType: 'default' }, source.publishMode));
      if (this.shuttingDown || !['starting', 'default_live', 'selected_live'].includes(this.mustFind(id).status)) { await publisher.stop(); return false; }
      this.runtimes.set(id, { publisher, pendingPublisher: null, ingest: acquired.ingest, busy: false, lastHeartbeat: this.now(), lastDecisionPollCompletedAt: null, defaultMedia: source, selectedSourceUri: null, switchAbort: null, switchTask: null, restoreTask: null });
      if (this.shuttingDown) return false;
      if (baseline.is_live) {
        await timed(this.log, 'ivs_takeover_confirmation', this.context(id), () => waitForTakeover(publisher,
          () => this.node.status(session.goLiveSessionId!, session.ownerId), baseline, 12000, undefined,
          (probe) => this.log.info?.({ ...this.context(id), event: 'demo_ivs_takeover_probe', ...probe }, 'Demo IVS takeover probe')));
      } else {
        await timed(this.log, 'ivs_initial_live_confirmation', this.context(id), () => this.node.start(session.goLiveSessionId!, session.ownerId));
      }
      if (!publisher.alive()) throw new Error('Recovery publisher exited');
      session = this.mustFind(id);
      if (!['starting', 'default_live', 'selected_live'].includes(session.status)) { await publisher.stop(); return false; }
      session.priority = priority;
      session.takeoverCount += 1;
      session.assetType = 'default';
      session.assetId = null;
      session.decisionId = null;
      session.selectedStartedAt = null;
      session.selectedDurationSeconds = null;
      session.selectedExpiresAt = null;
      session = transition(session, 'default_live');
      session.operation = null;
      this.repository.save(session);
      await this.reportContent(session);
      this.runLoop(id);
      return true;
    } catch (error) {
      if (this.shuttingDown) return false;
      this.log.error({ demoId: id, error: safeError(error) }, 'Demo recovery failed');
      const failed = this.repository.find(id);
      if (failed) { failed.error = 'Demo could not recover'; this.repository.save(failed); }
      await this.stopInternal(id, true);
      return false;
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
          if (this.now() >= Date.parse(session.expiresAt)) { await this.stopInternal(id, false); return; }
          const runtime = this.runtimes.get(id);
          if (!runtime?.publisher.alive()) { await this.stopInternal(id, true); return; }
          try {
            if (this.now() - runtime.lastHeartbeat >= this.config.heartbeatIntervalMs && session.goLiveSessionId) {
              await this.node.heartbeat(session.goLiveSessionId, session.ownerId);
              runtime.lastHeartbeat = this.now();
            }
            await this.pollDecisions(id);
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
    const runtime = this.runtimes.get(id);
    const pollStarted = performance.now();
    const pollStartedAt = new Date().toISOString();
    const sincePriorPollCompletedMs = runtime?.lastDecisionPollCompletedAt === null || runtime?.lastDecisionPollCompletedAt === undefined
      ? null : Math.round((pollStarted - runtime.lastDecisionPollCompletedAt) * 100) / 100;
    const feed = await timed(this.log, 'laravel_decision_poll', this.context(id), () => this.laravel.decisions(session.adaptiveSessionId, session.decisionCursor), 'debug');
    const pollRequestMs = Math.round((performance.now() - pollStarted) * 100) / 100;
    if (runtime) runtime.lastDecisionPollCompletedAt = performance.now();
    if (feed.owner_id !== session.ownerId || feed.unit_ids.length !== 1 || feed.unit_ids[0] !== session.unitId) {
      throw new Error('Decision feed identity changed');
    }
    if (feed.state === 'STOPPED') { await this.stopInternal(id, false); return; }
    session = this.mustFind(id);
    if (!['default_live', 'selected_live'].includes(session.status) || session.operation === 'restoring_default') return;
    const fresh = feed.decisions.filter((decision) => decision.cycle_number > session.decisionCursor)
      .sort((a, b) => b.cycle_number - a.cycle_number);
    if (!fresh.length) return;
    for (const decision of fresh) {
      const decidedMs = Date.parse(decision.decided_at ?? '');
      const generatedMs = Date.parse(feed.generated_at ?? '');
      this.log.info?.({ ...this.context(id), event: 'demo_decision_received',
        receivedAt: new Date().toISOString(), decisionId: decision.decision_id, cycleNumber: decision.cycle_number,
        result: decision.result, assetId: decision.asset?.id ?? null, decidedAt: decision.decided_at ?? null,
        feedGeneratedAt: feed.generated_at ?? null,
        decisionToFeedMs: Number.isFinite(decidedMs) && Number.isFinite(generatedMs) && generatedMs >= decidedMs
          ? generatedMs - decidedMs : null,
        pollStartedAt, pollRequestMs, sincePriorPollCompletedMs,
        configuredPollIntervalMs: this.config.pollIntervalMs, decisionsInResponse: fresh.length }, 'Demo decision received');
    }
    // Persist consumption before attempting a switch; recovery never replays a choice.
    session.decisionCursor = fresh[0]!.cycle_number;
    this.repository.save(session);
    const choice = fresh.find((decision) => this.validDecision(decision, session));
    if (choice) await this.switchSelected(id, choice);
  }

  private validDecision(decision: Decision, session: DemoSession): boolean {
    if (decision.result !== 'SELECT_ASSET' || !decision.asset) return false;
    if (decision.decision_id === session.decisionId) return false;
    if ((decision.asset.id !== session.assetId || this.runtimes.get(session.id)?.selectedSourceUri !== decision.asset.s3_uri) && !hasSelectedCapacity(session.takeoverCount)) return false;
    if (decision.expires_at && (!Number.isFinite(Date.parse(decision.expires_at)) || Date.parse(decision.expires_at) <= this.now())) return false;
    return /^s3:\/\/[^/]+\/.+\.mp4$/i.test(decision.asset.s3_uri);
  }

  private renewSelection(session: DemoSession, decisionId: string): void {
    session.decisionId = decisionId;
    session.selectedStartedAt = new Date(this.now()).toISOString();
    session.selectedExpiresAt = new Date(this.now() + this.config.selectedAssetHoldSeconds * 1000).toISOString();
    this.repository.save(session);
    this.log.info?.({ demoId: session.id, decisionId, selectedExpiresAt: session.selectedExpiresAt }, 'Demo selection window started');
  }

  private async switchSelected(id: string, decision: Decision): Promise<void> {
    const before = this.mustFind(id);
    const startedAt = new Date().toISOString();
    const start = performance.now();
    await timed(this.log, 'decision_handling', this.context(id, decision), () => this.switchSelectedWork(id, decision));
    const after = this.mustFind(id);
    this.log.info?.({ ...this.context(id, decision), event: 'demo_decision_handled', startedAt,
      endedAt: new Date().toISOString(), durationMs: Math.round((performance.now() - start) * 100) / 100,
      outcome: after.status === 'selected_live' && after.decisionId === decision.decision_id
        ? (after.takeoverCount > before.takeoverCount ? 'switched' : 'renewed') : 'skipped' }, 'Demo decision handling result');
  }

  private async switchSelectedWork(id: string, decision: Decision): Promise<void> {
    if (!decision.asset) return;
    let session = this.mustFind(id);
    if (session.status === 'selected_live' && session.assetId === decision.asset.id && this.runtimes.get(id)?.selectedSourceUri === decision.asset.s3_uri && session.operation === null) {
      this.renewSelection(session, decision.decision_id);
      return;
    }
    // Preparation must not hold the publisher lock or block deadline restoration.
    const media = await timed(this.log, 'selected_media_prepare', this.context(id, decision), () => this.media.prepare(decision.asset!.s3_uri, decision.decision_id, this.context(id, decision), decision.asset!.media_profile));
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    await timed(this.log, 'publisher_lock_wait', this.context(id, decision), async () => {
      await runtime.restoreTask?.catch(() => undefined);
      await runtime.switchTask?.catch(() => undefined);
    });
    session = this.mustFind(id);
    if (this.shuttingDown || !['default_live', 'selected_live'].includes(session.status) || !this.validDecision(decision, session)) return;
    if (session.selectedExpiresAt && this.now() >= Date.parse(session.selectedExpiresAt)) return;
    try { await this.switchPublisher(id, media, 'selected', decision.asset.id, decision.decision_id); }
    finally {
      if (this.repository.find(id)?.decisionId === decision.decision_id) runtime.selectedSourceUri = decision.asset.s3_uri;
    }
  }

  private watchDeadlines(id: string): void {
    if (this.watchdogs.has(id)) return;
    const timer = setInterval(() => {
      const session = this.repository.find(id);
      if (!session || isTerminal(session.status)) {
        clearInterval(timer); this.watchdogs.delete(id); return;
      }
      if (this.shuttingDown || session.status === 'stopping') return;
      const now = this.now();
      if (now >= Date.parse(session.expiresAt) || (session.presenceExpiresAt && now >= Date.parse(session.presenceExpiresAt))) {
        void this.stopInternal(id, false, session.presenceExpiresAt && now >= Date.parse(session.presenceExpiresAt) ? 'presence_expired' : 'maximum_duration');
        return;
      }
      if (session.status === 'selected_live' && session.selectedExpiresAt && now >= Date.parse(session.selectedExpiresAt) && session.operation !== 'restoring_default') {
        const runtime = this.runtimes.get(id);
        if (!runtime) return;
        session.operation = 'restoring_default';
        this.repository.save(session);
        runtime.switchAbort?.abort();
        const previous = runtime.switchTask;
        const restore = (async () => {
          await previous?.catch(() => undefined);
          const current = this.mustFind(id);
          if (current.status !== 'selected_live' || current.decisionId !== session.decisionId || current.selectedExpiresAt !== session.selectedExpiresAt) return;
          this.log.info?.({ demoId: id, decisionId: current.decisionId }, 'Demo selected playback expired');
          await this.switchPublisher(id, runtime.defaultMedia, 'default', null, null);
        })().catch(async (error) => {
          this.log.error({ demoId: id, error: safeError(error) }, 'Default restoration failed');
          const current = this.mustFind(id);
          if (!isTerminal(current.status) && current.status !== 'stopping') {
            current.error = 'Default playback could not be restored'; this.repository.save(current);
            await this.stopInternal(id, true, 'default_restore_failed');
          }
        });
        runtime.restoreTask = restore;
        void restore.finally(() => { if (runtime.restoreTask === restore) runtime.restoreTask = null; }).catch(() => undefined);
      }
    }, 100);
    timer.unref();
    this.watchdogs.set(id, timer);
  }

  private async switchPublisher(id: string, media: PreparedMedia,
    type: 'default' | 'selected', assetId: number | null, decisionId: string | null): Promise<void> {
    const runtime = this.runtimes.get(id);
    const session = this.mustFind(id);
    if (!runtime || this.shuttingDown || !['default_live', 'selected_live'].includes(session.status)) return;
    if (runtime.switchTask) throw new Error('Publisher is busy');
    const controller = new AbortController();
    runtime.switchAbort = controller;
    session.operation = type === 'default' ? 'restoring_default' : 'switching_selected';
    this.repository.save(session);
    const task = timed(this.log, 'asset_transition', { ...this.context(id), assetType: type, assetId, decisionId }, () => this.takeover(id, media, type, assetId, decisionId, controller.signal));
    runtime.switchTask = task;
    try { await task; }
    finally {
      if (runtime.switchTask === task) { runtime.switchTask = null; runtime.switchAbort = null; }
      const current = this.repository.find(id);
      if (current?.operation === (type === 'default' ? 'restoring_default' : 'switching_selected')) {
        current.operation = null; this.repository.save(current);
      }
    }
  }

  private async takeover(id: string, media: PreparedMedia,
    type: 'default' | 'selected', assetId: number | null, decisionId: string | null, signal: AbortSignal): Promise<void> {
    const current = this.mustFind(id);
    const runtime = this.runtimes.get(id);
    if (!runtime || !current.goLiveSessionId || runtime.busy) throw new Error('Publisher is unavailable');
    runtime.busy = true;
    let replacement: Publisher | null = null;
    const switchContext = { ...this.context(id), assetType: type, assetId, decisionId };
    try {
      const baseline = await timed(this.log, 'ivs_status_baseline', switchContext, () => abortable(this.node.status(current.goLiveSessionId!, current.ownerId), signal));
      if (!baseline.is_live) throw new Error('IVS stream is not live');
      const starting = timed(this.log, 'ffmpeg_spawn', switchContext, () => this.ffmpeg.start(media.path, media.hasAudio, media.durationSeconds, runtime.ingest, current.priority + 1, switchContext, media.publishMode));
      starting.then((publisher) => { if (signal.aborted) void publisher.stop(); }, () => undefined);
      replacement = await abortable(starting, signal);
      if (this.shuttingDown || signal.aborted) { await replacement.stop(); return; }
      runtime.pendingPublisher = replacement;
      await timed(this.log, 'ivs_takeover_confirmation', switchContext, () => waitForTakeover(replacement!,
        () => this.node.status(current.goLiveSessionId!, current.ownerId), baseline, 12000, signal,
        (probe) => this.log.info?.({ ...switchContext, event: 'demo_ivs_takeover_probe', ...probe }, 'Demo IVS takeover probe')));
      const latest = this.mustFind(id);
      if (signal.aborted || this.shuttingDown || !['default_live', 'selected_live'].includes(latest.status)) { await replacement.stop(); return; }
      const previous = runtime.publisher;
      runtime.publisher = replacement;
      latest.priority += 1;
      latest.takeoverCount += 1;
      latest.assetType = type;
      if (type === 'default') runtime.selectedSourceUri = null;
      latest.assetId = assetId;
      latest.decisionId = decisionId;
      latest.selectedStartedAt = type === 'selected' ? new Date(this.now()).toISOString() : null;
      latest.selectedDurationSeconds = type === 'selected' ? media.durationSeconds : null;
      latest.selectedExpiresAt = type === 'selected' ? new Date(this.now() + this.config.selectedAssetHoldSeconds * 1000).toISOString() : null;
      this.repository.save(transition(latest, type === 'selected' ? 'selected_live' : 'default_live'));
      this.log.info?.({ ...switchContext, event: 'demo_source_switched', confirmedAt: new Date().toISOString(),
        sourceVersion: latest.takeoverCount + 1, fromAssetType: current.assetType,
        fromAssetId: current.assetId, selectedExpiresAt: latest.selectedExpiresAt }, 'Demo source switched');
      await timed(this.log, 'previous_publisher_stop', switchContext, () => abortable(previous.stop(), signal));
      await abortable(this.reportContent(this.mustFind(id)), signal);
    } catch (error) {
      if (replacement && replacement !== runtime.publisher) await replacement.stop();
      throw error;
    } finally { runtime.pendingPublisher = null; runtime.busy = false; }
  }

  private async reportContent(session: DemoSession): Promise<void> {
    if (!session.goLiveSessionId) return;
    try { await timed(this.log, 'go_live_content_report', this.context(session.id), () => this.node.content(session.goLiveSessionId!, session.ownerId, session.assetType, session.assetId, session.takeoverCount + 1)); }
    catch (error) { this.log.warn({ demoId: session.id, error: safeError(error) }, 'Node content update failed'); }
  }

  private async stopInternal(id: string, failed: boolean, reason = 'stop_requested'): Promise<void> {
    if (this.stopping.has(id)) return;
    this.stopping.add(id);
    try {
      let session = this.mustFind(id);
      if (isTerminal(session.status)) return;
      this.startupTimings.delete(id);
      this.log.info?.({ demoId: id, reason }, 'Demo shutdown requested');
      session = transition(session, 'stopping');
      session.operation = null;
      this.repository.save(session);
      const runtime = this.runtimes.get(id);
      if (runtime) {
        runtime.switchAbort?.abort();
        await Promise.all([runtime.publisher.stop(), runtime.pendingPublisher?.stop()]);
        this.runtimes.delete(id);
      }
      if (session.goLiveSessionId && !session.nodeStopped) {
        try { await timed(this.log, 'go_live_session_stop', this.context(id), () => this.node.stop(session.goLiveSessionId!, session.ownerId)); session.nodeStopped = true; this.repository.save(session); }
        catch (error) { this.log.warn({ demoId: id, error: safeError(error) }, 'Node stop will retry'); }
      } else if (!session.goLiveSessionId && !this.creatingNodeSession.has(id)) {
        session.nodeStopped = true;
        this.repository.save(session);
      }
      if (!session.laravelStopped) {
        try { await timed(this.log, 'laravel_session_stop', this.context(id), () => this.laravel.stop(session.adaptiveSessionId)); session.laravelStopped = true; this.repository.save(session); }
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

  private context(id: string, decision?: Decision): TimingContext {
    const session = this.repository.find(id);
    return { demoId: id, adaptiveSessionId: session?.adaptiveSessionId, goLiveSessionId: session?.goLiveSessionId,
      unitId: session?.unitId, assetType: decision ? 'selected' : session?.assetType,
      assetId: decision ? decision.asset?.id : session?.assetId, decisionId: decision?.decision_id ?? session?.decisionId,
      ...(decision ? { cycleNumber: decision.cycle_number } : {}) };
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
