import {
  Alert,
  Badge,
  Button,
  Card,
  Cluster,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  FormActions,
  Link,
  Modal,
  Page,
  PageHeader,
  Section,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { RefusalError, unreachableRefusal } from '../lib/api';
import { useCan } from '../lib/auth';
import {
  BUILD_STAGES,
  BUILD_STATE_LABEL,
  STAGE_LABEL,
  TRIGGER_LABEL,
  buildStateTone,
  builds,
  formatDuration,
  isTerminalBuild,
  sha7,
  useBuildStream,
  type BuildDetail as Detail,
  type BuildLogChunk,
  type BuildStage,
  type BuildStageView,
  type BuildStreamOptions,
  type Transport,
} from '../lib/builds';
import { formatRelativeTime } from '../lib/timeline';

/**
 * Build detail, `/builds/:id` (SHP-T-7.12, SHP-REQ-142, SHP-REQ-143): the five stages in order
 * with their state and duration, the log streamed over SSE (polled while the stream is down),
 * what the build pushed or why it did not, and the deploy it requested. A deployer can cancel an
 * open build (it stops at the next stage boundary) and rebuild a finished one; a viewer sees
 * neither button.
 */

/** The log scrolls inside its own box and wraps anywhere, never widening a 375 px page. */
const LOG_STYLE: CSSProperties = {
  margin: 0,
  minHeight: 'var(--space-64)',
  maxHeight: 'calc(var(--space-64) * 6)',
  overflow: 'auto',
  padding: 'var(--space-8)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-12)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};

const MONO_STYLE: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-12)',
  overflowWrap: 'anywhere',
};

const MUTED_STYLE: CSSProperties = {
  color: 'var(--color-fg-muted)',
  fontSize: 'var(--text-13)',
};

/**
 * Focuses `el` once no dialog is open any more. The dialog hands focus back to what opened it as it
 * unmounts — after its exit animation — so focusing any earlier is undone; and the button that
 * opened it is gone by then.
 */
function focusAfterDialog(el: HTMLElement): () => void {
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const started = Date.now();
  const tick = (): void => {
    if (document.querySelector('[role="dialog"], [role="alertdialog"]') !== null && Date.now() - started < 2000) {
      frame = requestAnimationFrame(tick);
      return;
    }
    timer = setTimeout(() => {
      el.focus();
    }, 0);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
  };
}

/** How close to the bottom still counts as "following" the log. */
const FOLLOW_SLACK_PX = 24;

function stageDuration(view: BuildStageView, now: number): string {
  const end = view.endedAt === null ? now : Date.parse(view.endedAt);
  return formatDuration(end - Date.parse(view.startedAt));
}

const STAGE_STATE_LABEL: Record<BuildStageView['state'], string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
};

function StageItem({ stage, view, build }: { stage: BuildStage; view: BuildStageView | undefined; build: Detail }) {
  const current = view?.state === 'running' && !isTerminalBuild(build.state);
  let label: string;
  let tone: 'neutral' | 'attention' | 'danger' = 'neutral';
  if (view === undefined) {
    label = isTerminalBuild(build.state) ? 'Did not run' : 'Waiting';
  } else if (view.state === 'running' && isTerminalBuild(build.state)) {
    label = 'Stopped';
  } else {
    label = STAGE_STATE_LABEL[view.state];
    if (view.state === 'failed') tone = 'danger';
    if (view.state === 'running') tone = 'attention';
  }
  return (
    <Card as="li" padding="sm" selected={current} aria-current={current ? 'step' : undefined}>
      <Cluster gap="8" justify="between">
        <strong>{STAGE_LABEL[stage]}</strong>
        <Cluster gap="8">
          <Badge tone={tone}>{label}</Badge>
          {view !== undefined ? <span style={MUTED_STYLE}>{stageDuration(view, Date.now())}</span> : null}
        </Cluster>
      </Cluster>
    </Card>
  );
}

function TransportNote({ transport, done }: { transport: Transport; done: boolean }) {
  const text = done ? 'Finished' : transport === 'live' ? 'Live' : transport === 'polling' ? 'Polling (reconnecting)' : 'Connecting…';
  return (
    <span style={MUTED_STYLE} data-transport={transport}>
      {text}
    </span>
  );
}

/** The log, one box; a stage's first chunk is headed by the stage's name. */
function BuildLog({ logs, build }: { logs: BuildLogChunk[]; build: Detail }) {
  const boxRef = useRef<HTMLPreElement | null>(null);
  const [following, setFollowing] = useState(true);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box !== null && following) box.scrollTop = box.scrollHeight;
  }, [logs, following]);

  const open = !isTerminalBuild(build.state);
  const lastStage = logs[logs.length - 1]?.stage;
  // Said once per stage and once at the end, not once per line: a screen reader stays usable.
  const summary = open
    ? lastStage === undefined
      ? 'Waiting for the log.'
      : `Log: ${STAGE_LABEL[lastStage]} in progress.`
    : `Log complete: ${String(logs.length)} ${logs.length === 1 ? 'chunk' : 'chunks'}.`;

  const parts: { key: string; stage: BuildStage | null; text: string }[] = [];
  let prev: BuildStage | null = null;
  for (const chunk of logs) {
    if (chunk.stage !== prev) {
      parts.push({ key: `h-${chunk.id}`, stage: chunk.stage, text: `── ${STAGE_LABEL[chunk.stage]} ──\n` });
      prev = chunk.stage;
    }
    parts.push({ key: chunk.id, stage: null, text: chunk.chunk.endsWith('\n') ? chunk.chunk : `${chunk.chunk}\n` });
  }

  return (
    <Stack gap="8">
      <span className="shp-visually-hidden" aria-live="polite">
        {summary}
      </span>
      {logs.length === 0 ? (
        <p style={MUTED_STYLE}>{open ? 'No output yet. It appears here as each stage writes it.' : 'This build wrote no log.'}</p>
      ) : (
        <pre
          ref={boxRef}
          style={LOG_STYLE}
          tabIndex={0}
          aria-label="Build log"
          data-testid="build-log"
          onScroll={(e) => {
            const box = e.currentTarget;
            const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= FOLLOW_SLACK_PX;
            if (atBottom !== following) setFollowing(atBottom);
          }}
        >
          {parts.map((p) =>
            p.stage !== null ? (
              <span key={p.key} style={{ color: 'var(--color-fg-muted)' }}>
                {p.text}
              </span>
            ) : (
              <span key={p.key}>{p.text}</span>
            ),
          )}
        </pre>
      )}
      {!following && logs.length > 0 ? (
        <div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setFollowing(true);
            }}
          >
            Follow the log
          </Button>
        </div>
      ) : null}
    </Stack>
  );
}

function Outcome({ build }: { build: Detail }) {
  if (build.state === 'succeeded') {
    const digests = Object.entries(build.digests).sort(([a], [b]) => a.localeCompare(b));
    return (
      <Alert tone="success" title="Built and pushed">
        {digests.length === 0 ? (
          <span>No digests were reported.</span>
        ) : (
          <DescriptionList>
            {digests.map(([service, digest]) => (
              <DescriptionItem key={service} term={service}>
                <code style={MONO_STYLE}>{digest}</code>
              </DescriptionItem>
            ))}
          </DescriptionList>
        )}
      </Alert>
    );
  }
  if (build.state === 'cancelled') {
    return (
      <Alert tone="warning" title="Cancelled">
        It stopped at a stage boundary; nothing was pushed after it.
      </Alert>
    );
  }
  const title =
    build.state === 'refused' ? 'Refused' : build.failedStage !== null ? `Failed at ${STAGE_LABEL[build.failedStage]}` : 'Failed';
  return (
    <Alert tone="danger" title={title}>
      {build.refusal !== null ? (
        <Stack gap="4">
          <span>{build.refusal.message}</span>
          <span>{build.refusal.fix}</span>
        </Stack>
      ) : (
        <span>No reason was recorded; the log below shows where it stopped.</span>
      )}
    </Alert>
  );
}

function AutoDeploy({ build }: { build: Detail }) {
  if (build.autoDeployId !== undefined && build.autoDeployId !== null) {
    return (
      <Alert tone="info" title="Deploy requested">
        This build asked for a deploy of what it pushed.{' '}
        <Link asChild variant="inline">
          <RouterLink to={`/deploys/${build.autoDeployId}`}>See the deploy</RouterLink>
        </Link>
      </Alert>
    );
  }
  if (build.autoDeployRefusal !== undefined && build.autoDeployRefusal !== null) {
    return (
      <Alert tone="warning" title="The automatic deploy was refused">
        <Stack gap="4">
          <span>{build.autoDeployRefusal.message}</span>
          <span>{build.autoDeployRefusal.fix}</span>
        </Stack>
      </Alert>
    );
  }
  return null;
}

export function BuildDetailView({ id, options }: { id: string; options?: BuildStreamOptions }) {
  const { build, logs, transport, error, done } = useBuildStream(id, options);
  const can = useCan();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'cancel' | 'rebuild' | null>(null);
  const [actionError, setActionError] = useState<RefusalError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Set once Cancel was accepted: the button goes at once, before the stream says so. */
  const [cancelSent, setCancelSent] = useState(false);
  const [refocus, setRefocus] = useState(0);
  const stateRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = stateRef.current;
    if (refocus === 0 || el === null) return;
    return focusAfterDialog(el);
  }, [refocus]);

  const back = (
    <Link asChild>
      <RouterLink to={build === null ? '/builds' : `/builds?app=${encodeURIComponent(build.app)}`}>Builds</RouterLink>
    </Link>
  );

  if (error !== null) {
    return (
      <Page width="narrow">
        <Stack gap="24">
          <PageHeader title="Build" back={back} />
          <EmptyState kind={error.status === 404 ? 'no-results' : 'no-access'} heading={error.message} headingLevel={2}>
            {error.fix}
          </EmptyState>
        </Stack>
      </Page>
    );
  }

  if (build === null) {
    return (
      <Page width="narrow" aria-busy="true">
        <Stack gap="24">
          <PageHeader title="Build" back={back} />
          <span role="status" className="shp-visually-hidden">
            Loading the build
          </span>
          <Skeleton variant="text" lines={2} />
          <Skeleton variant="block" height={96} />
        </Stack>
      </Page>
    );
  }

  const terminal = isTerminalBuild(build.state);
  const canCancel = can && !terminal && build.cancelRequestedAt === null && !cancelSent;
  const canRebuild = can && terminal;

  const onActionError = (err: unknown): void => {
    setActionError(err instanceof RefusalError ? err : unreachableRefusal());
  };

  const cancel = async (): Promise<void> => {
    setBusy('cancel');
    setActionError(null);
    try {
      const res = await builds.cancel(build.buildId);
      setNotice(res.cancelRequested ? 'Cancel requested. The build stops at its next stage boundary.' : 'Build cancelled.');
      setCancelSent(true);
      setConfirming(false);
      // The Cancel button is gone now: put focus on the state it changed rather than on the page body.
      setRefocus((n) => n + 1);
    } catch (err) {
      setConfirming(false);
      onActionError(err);
    } finally {
      setBusy(null);
    }
  };

  const rebuild = async (): Promise<void> => {
    setBusy('rebuild');
    setActionError(null);
    try {
      const res = await builds.rebuild(build.buildId);
      setNotice(null);
      void navigate(`/builds/${res.buildId}`);
    } catch (err) {
      onActionError(err);
    } finally {
      setBusy(null);
    }
  };

  const actions =
    canCancel || canRebuild ? (
      <Cluster gap="8">
        {canRebuild ? (
          <Button
            type="button"
            variant="primary"
            loading={busy === 'rebuild'}
            onClick={() => {
              void rebuild();
            }}
          >
            Rebuild
          </Button>
        ) : null}
        {canCancel ? (
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Cancel build
          </Button>
        ) : null}
      </Cluster>
    ) : undefined;

  const stageByName = new Map(build.stages.map((s) => [s.stage, s]));

  return (
    <Page width="narrow">
      <Stack gap="24">
        <PageHeader
          title={`Build ${build.app} ${sha7(build.sha)}`}
          back={back}
          description={`${TRIGGER_LABEL[build.trigger]} · requested by ${build.requesterLabel} · ${formatRelativeTime(build.createdAt)}`}
          {...(actions !== undefined ? { actions } : {})}
        />

        <div ref={stateRef} tabIndex={-1} role="group" aria-label="Build state">
          <Cluster gap="12" justify="between">
            <Cluster gap="8">
              <Badge tone={buildStateTone(build.state)}>{BUILD_STATE_LABEL[build.state]}</Badge>
              <TransportNote transport={transport} done={done} />
            </Cluster>
            <Link asChild>
              <RouterLink to={`/apps/${encodeURIComponent(build.app)}`}>{build.app}</RouterLink>
            </Link>
          </Cluster>
        </div>

        {actionError !== null ? (
          <Alert tone="danger" title={actionError.message} dynamic>
            {actionError.fix}
          </Alert>
        ) : null}
        {notice !== null ? (
          <Alert tone="info" title={notice} dynamic>
            {terminal ? 'Nothing more will change.' : 'Progress keeps streaming below.'}
          </Alert>
        ) : null}
        {!terminal && build.cancelRequestedAt !== null && notice === null ? (
          <Alert tone="warning" title="Cancel requested">
            The build stops at its next stage boundary; the stage in progress finishes first.
          </Alert>
        ) : null}

        {terminal ? <Outcome build={build} /> : null}
        <AutoDeploy build={build} />

        <Section title="Details" surface="plain">
          <DescriptionList>
            <DescriptionItem term="Commit">
              <code style={MONO_STYLE}>{build.sha}</code>
            </DescriptionItem>
            <DescriptionItem term="Trigger">{TRIGGER_LABEL[build.trigger]}</DescriptionItem>
            <DescriptionItem term="Requested by">{build.requesterLabel}</DescriptionItem>
            {build.rebuildOfId !== null ? (
              <DescriptionItem term="Rebuild of">
                <Link asChild>
                  <RouterLink to={`/builds/${build.rebuildOfId}`}>The earlier build</RouterLink>
                </Link>
              </DescriptionItem>
            ) : null}
            {build.startedAt !== null && build.endedAt !== null ? (
              <DescriptionItem term="Took" numeric>
                {formatDuration(Date.parse(build.endedAt) - Date.parse(build.startedAt))}
              </DescriptionItem>
            ) : null}
          </DescriptionList>
        </Section>

        <Section title="Stages" surface="plain">
          <Stack as="ol" gap="8" aria-label="Build stages">
            {BUILD_STAGES.map((stage) => (
              <StageItem key={stage} stage={stage} view={stageByName.get(stage)} build={build} />
            ))}
          </Stack>
          {build.state === 'queued' ? <p style={MUTED_STYLE}>Queued: it starts when the agent is free.</p> : null}
        </Section>

        <Section title="Log" surface="plain">
          <BuildLog logs={logs} build={build} />
        </Section>
      </Stack>

      <Modal
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        title="Cancel this build?"
        description={
          build.state === 'queued'
            ? 'It has not started, so it ends now and nothing is built.'
            : 'It stops at the next stage boundary: the stage in progress finishes, nothing after it runs, and nothing is pushed after that.'
        }
        destructive
        footer={
          <FormActions>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep building
            </Button>
            <Button
              type="button"
              variant="danger"
              loading={busy === 'cancel'}
              onClick={() => {
                void cancel();
              }}
            >
              Cancel build
            </Button>
          </FormActions>
        }
      />
    </Page>
  );
}

export function BuildDetail() {
  const { id = '' } = useParams();
  return <BuildDetailView key={id} id={id} />;
}
