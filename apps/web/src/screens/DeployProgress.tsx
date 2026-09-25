import {
  Alert,
  Badge,
  Card,
  Cluster,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  Link,
  Page,
  PageHeader,
  Section,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import type { DeployStatus } from '@shipyard/schema';
import type { CSSProperties } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { isTerminal, useDeployProgress, type DeployStep, type ProgressOptions, type Transport } from '../lib/progress';

/**
 * Deploy in progress (S4), `/deploys/:id/live` (SHP-T-3.4, SHP-REQ-058). The steps as the agent
 * reports them — verify → backup → migrate → pull → swap → check → soak, whichever apply — with
 * the current one highlighted, then what shipped or why it did not. Streams over SSE and polls
 * every three seconds while the stream is down.
 */

/** Output wraps inside its own box and scrolls there, never the page (375 px). */
const OUTPUT_STYLE: CSSProperties = {
  margin: 0,
  maxHeight: 'calc(var(--space-64) * 4)',
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

const STATE_LABEL: Record<DeployStatus['state'], string> = {
  queued: 'Queued',
  awaiting_approval: 'Awaiting approval',
  locked: 'Waiting for the agent',
  verifying: 'Verifying',
  backing_up: 'Backing up',
  migrating: 'Migrating',
  pulling: 'Pulling',
  swapping: 'Swapping',
  checking: 'Checking',
  soaking: 'Soaking',
  rolling_back: 'Rolling back',
  succeeded: 'Succeeded',
  failed: 'Failed',
  rolled_back: 'Rolled back',
  refused: 'Refused',
  cancelled: 'Cancelled',
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.max(0, Math.round(ms)))} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)} s`;
  return `${String(Math.floor(s / 60))} m ${String(s % 60)} s`;
}

function stepDuration(step: DeployStep): string | null {
  if (step.endedAt === null) return null;
  return formatDuration(Date.parse(step.endedAt) - Date.parse(step.startedAt));
}

function failed(step: DeployStep): boolean {
  return step.exitCode !== null && step.exitCode !== 0;
}

function TransportNote({ transport, done }: { transport: Transport; done: boolean }) {
  const text = done
    ? 'Finished'
    : transport === 'live'
      ? 'Live'
      : transport === 'polling'
        ? 'Polling (reconnecting)'
        : 'Connecting…';
  return (
    <span role="status" style={MUTED_STYLE} data-transport={transport}>
      {text}
    </span>
  );
}

function StepItem({
  step,
  current,
  rollback,
}: {
  step: DeployStep;
  current: boolean;
  rollback: boolean;
}) {
  const duration = stepDuration(step);
  const isFailed = failed(step);
  const badge = isFailed ? (
    <Badge tone="danger">Failed (exit {step.exitCode})</Badge>
  ) : step.endedAt === null ? (
    <Badge tone={current ? 'attention' : 'neutral'}>{current ? 'Running' : 'Stopped'}</Badge>
  ) : (
    <Badge tone="neutral">Done</Badge>
  );
  return (
    <Card as="li" padding="sm" selected={current} aria-current={current ? 'step' : undefined}>
      <Stack gap="8">
        <Cluster gap="8" justify="between">
          <Cluster gap="8">
            <strong>{step.name}</strong>
            {rollback ? <Badge tone="neutral">Rollback</Badge> : null}
          </Cluster>
          <Cluster gap="8">
            {badge}
            {duration !== null ? <span style={MUTED_STYLE}>{duration}</span> : null}
          </Cluster>
        </Cluster>
        {step.argv.length > 0 ? <code style={MONO_STYLE}>{step.argv.join(' ')}</code> : null}
        {step.output !== null && step.output !== '' ? (
          <pre style={OUTPUT_STYLE} tabIndex={0} aria-label={`Output of ${step.name}`}>
            {step.output}
          </pre>
        ) : null}
      </Stack>
    </Card>
  );
}

function Outcome({ status }: { status: DeployStatus }) {
  if (status.state === 'succeeded') {
    return (
      <Alert tone="success" title={status.dryRun ? 'Dry run passed' : 'Deployed'}>
        <DescriptionList>
          {status.images.map((image) => (
            <DescriptionItem key={image.service} term={image.service}>
              <Stack gap="2">
                <code style={MONO_STYLE}>{image.sha}</code>
                <code style={MONO_STYLE}>{image.digest}</code>
              </Stack>
            </DescriptionItem>
          ))}
          <DescriptionItem term="Schema revision">
            <code style={MONO_STYLE}>{status.schemaRevision ?? 'none reported'}</code>
          </DescriptionItem>
        </DescriptionList>
      </Alert>
    );
  }
  const title =
    status.state === 'rolled_back'
      ? 'Rolled back'
      : status.state === 'refused'
        ? 'Refused'
        : status.state === 'cancelled'
          ? 'Cancelled'
          : 'Failed';
  return (
    <Alert tone={status.state === 'cancelled' ? 'warning' : 'danger'} title={title}>
      {status.refusal !== null ? (
        <Stack gap="4">
          <span>{status.refusal.message}</span>
          <span>{status.refusal.fix}</span>
        </Stack>
      ) : (
        <span>No reason was recorded; the steps above show where it stopped.</span>
      )}
    </Alert>
  );
}

export function DeployProgressView({ id, options }: { id: string; options?: ProgressOptions }) {
  const progress = useDeployProgress(id, options);
  const { status, steps, transport, error, done } = progress;
  const recordLink = (
    <Link asChild>
      <RouterLink to={`/deploys/${id}`}>Deploy record</RouterLink>
    </Link>
  );

  if (error !== null) {
    return (
      <Page width="narrow">
        <EmptyState
          kind={error.status === 404 ? 'no-results' : 'no-access'}
          heading={error.message}
          headingLevel={2}
          action={
            <Link asChild>
              <RouterLink to="/">Go to Home</RouterLink>
            </Link>
          }
        >
          {error.fix}
        </EmptyState>
      </Page>
    );
  }

  const title = status === null ? 'Deploy' : `${status.kind === 'rollback' ? 'Rollback' : 'Deploy'} ${status.app}`;
  const finished = status !== null && isTerminal(status.state);
  // The step being worked on: the last one without an end, while the deploy is still running.
  let currentIndex = -1;
  if (!finished) {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i]?.endedAt === null) {
        currentIndex = i;
        break;
      }
    }
  }
  const firstFailure = steps.findIndex(failed);

  return (
    <Page width="narrow">
      <Stack gap="24">
        <PageHeader
          title={title}
          description={
            status === null ? undefined : `${status.sha.slice(0, 7)} · requested by ${status.requester.label}`
          }
        />
        <Cluster gap="12" justify="between">
          <Cluster gap="8">
            {status !== null ? (
              <Badge tone={finished && status.state !== 'succeeded' ? 'danger' : 'neutral'}>
                {STATE_LABEL[status.state]}
              </Badge>
            ) : null}
            <TransportNote transport={transport} done={done} />
          </Cluster>
          {recordLink}
        </Cluster>
        {status !== null && finished ? <Outcome status={status} /> : null}
        <Section title="Steps" surface="plain">
          {status === null ? (
            <Skeleton variant="text" lines={3} />
          ) : steps.length === 0 ? (
            <p style={MUTED_STYLE}>No steps yet. {STATE_LABEL[status.state]}.</p>
          ) : (
            <Stack as="ol" gap="8" aria-label="Deploy steps">
              {steps.map((step, i) => (
                <StepItem
                  key={`${step.name}-${step.startedAt}`}
                  step={step}
                  current={i === currentIndex}
                  rollback={firstFailure >= 0 && i > firstFailure}
                />
              ))}
            </Stack>
          )}
        </Section>
      </Stack>
    </Page>
  );
}

export function DeployProgress() {
  const { id = '' } = useParams();
  return <DeployProgressView id={id} />;
}
