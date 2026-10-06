import {
  Alert,
  Badge,
  Button,
  Card,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  FormActions,
  Link,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  Section,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import type { DeployStatus } from '@shipyard/schema';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link as RouterLink, Navigate, useNavigate, useParams } from 'react-router-dom';
import { CheckName } from '../components/CheckName';
import { DryRunSheet, type SheetAction } from '../components/DryRunSheet';
import { OpenInConstellation } from '../components/OpenInConstellation';
import { deployStages, deploySteps, PipeLane, PipeNode, STATE_LABEL, type StepRow } from '../components/pipeline';
import { formatSpan } from '../components/pipeline/stages';
import { RefusalError } from '../lib/api';
import { sha7, stateTone } from '../lib/appstatus';
import { useCan } from '../lib/auth';
import {
  clockTime,
  dateTime,
  decideApproval,
  lastLine,
  liveBefore,
  migrated,
  soakClock,
  useCiRunUrl,
  useDeployAppContext,
  useForemanPosts,
  type SoakClock,
} from '../lib/deploy';
import { useDeployProgress, type DeployStep, type ProgressOptions, type Transport } from '../lib/progress';
import { memberTone } from '../lib/rollouts';
import type { ForemanStatus } from '../lib/timeline';
import { approveVerb, stateWords, VERBS } from '../lib/words';

/**
 * The deploy page (SHP-T-13.11, SHP-REQ-162, SHP-DA-005): one page at `/deploys/:id` that streams
 * while the deploy runs and is its record afterwards — the same URL Activity, Home and the app page
 * link to. It leads with the verdict (what is live now, and why), then the planned steps with their
 * timers, the soak counted from the manifest's soak and the recorded soak step (so a reload reads
 * the same numbers), the refused check with its fix, a held approval's Approve and Deny, and a
 * next-action bar on every state. It replaces the live view and the record, which each buried the
 * outcome and ended in a dead end.
 *
 * `/deploys/:id/live` survives as a redirect for every link and bookmark that still names it.
 */

// ── Clock ───────────────────────────────────────────────────────────────

/** Ticks each second while the deploy runs, so timers move; a pinned `now` (tests) never ticks. */
function useClock(active: boolean, pinned: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || pinned !== undefined) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active, pinned]);
  return pinned ?? now;
}

function span(from: string, to: string | number): string {
  const a = Date.parse(from);
  const b = typeof to === 'number' ? to : Date.parse(to);
  return Number.isNaN(a) || Number.isNaN(b) ? '' : formatSpan(b - a);
}

// ── Small pieces ────────────────────────────────────────────────────────

function TransportNote({ transport, done }: { transport: Transport; done: boolean }) {
  const text = done
    ? 'Finished'
    : transport === 'live'
      ? 'Live'
      : transport === 'polling'
        ? 'Polling (reconnecting)'
        : 'Connecting…';
  return (
    <span role="status" className="shp-deploy-transport" data-transport={transport}>
      {text}
    </span>
  );
}

function Breadcrumb({ app, current }: { app: string; current: string }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="shp-crumbs">
        <li>
          <Link asChild>
            <RouterLink to="/">Apps</RouterLink>
          </Link>
        </li>
        <li>
          <Link asChild>
            <RouterLink to={`/apps/${encodeURIComponent(app)}`}>{app}</RouterLink>
          </Link>
        </li>
        <li aria-current="page">{current}</li>
      </ol>
    </nav>
  );
}

function titleFor(status: DeployStatus): { title: string; crumb: string } {
  const short = sha7(status.sha);
  switch (status.kind) {
    case 'rollback':
      return { title: `${VERBS.rollBack} ${status.app} to ${short}`, crumb: `${VERBS.rollBack} ${short}` };
    case 'restore':
      return { title: `Restore ${status.app}`, crumb: 'Restore' };
    case 'deploy':
      return { title: `Deploy ${status.app} ${short}`, crumb: `Deploy ${short}` };
  }
}

// ── The verdict ─────────────────────────────────────────────────────────

interface VerdictInput {
  status: DeployStatus;
  rows: readonly StepRow[];
  steps: readonly DeployStep[];
  soak: SoakClock | null;
  soakSeconds: number | null;
  before: string | null;
  branch: string | null;
}

/** The refusal, verbatim: its message, then its fix (every refusal is { code, gate, message, fix }). */
function RefusalLines({ status }: { status: DeployStatus }) {
  if (status.refusal === null) return null;
  return (
    <>
      <p className="shp-deploy-verdict__cause">{status.refusal.message}</p>
      <p className="shp-deploy-verdict__fix">{status.refusal.fix}</p>
    </>
  );
}

/** What the banner says for each state: a title that is the outcome, then what it means. */
function verdict({ status, rows, steps, soak, soakSeconds, before, branch }: VerdictInput): { title: ReactNode; body: ReactNode } {
  const short = sha7(status.sha);
  const prev = before === null ? null : sha7(before);
  const stays = prev === null ? 'What was live stays live.' : `${prev} stays live.`;

  if (status.dryRun && (status.state === 'succeeded' || status.state === 'failed' || status.state === 'refused')) {
    const failedCheck = status.refusal !== null && status.refusal.gate !== 'none' ? status.refusal.gate : null;
    return {
      title:
        status.state === 'succeeded' ? (
          'Dry run passed'
        ) : failedCheck !== null ? (
          <>
            Dry run refused · <CheckName gate={failedCheck} branch={branch} />
          </>
        ) : (
          `Dry run ${stateWords(status.state).toLowerCase()}`
        ),
      body: (
        <>
          <RefusalLines status={status} />
          <p>It was a dry run: the checks ran and nothing was deployed. {stays}</p>
        </>
      ),
    };
  }

  switch (status.state) {
    case 'awaiting_approval':
      return {
        title: stateWords('awaiting_approval'),
        body: (
          <p>
            {status.requester.label} asked to deploy {short} to {status.app}. Nothing runs until someone with the deployer
            role approves it. {stays}
          </p>
        ),
      };
    case 'queued':
    case 'locked':
      return { title: stateWords(status.state), body: <p>Nothing has changed yet. {stays}</p> };
    case 'verifying':
      return {
        title: stateWords('verifying'),
        body: <p>Running the checks against GitHub and GHCR. Nothing has changed yet. {stays}</p>,
      };
    case 'backing_up':
    case 'migrating':
    case 'pulling':
    case 'swapping':
      return {
        title: stateWords(status.state),
        body: <p>{prev === null ? `${short} is being deployed.` : `${short} is being deployed; ${prev} serves traffic until the swap.`}</p>,
      };
    case 'checking':
      return {
        title: stateWords('checking'),
        body: <p>{short} is running. Shipyard is matching its digests, revision label and /health before the soak.</p>,
      };
    case 'soaking': {
      const watch = soakSeconds === null ? '' : ` for ${String(soakSeconds)}s`;
      return {
        title: soak === null ? stateWords('soaking') : `${stateWords('soaking')} · ${String(soak.elapsed)}s of ${String(soak.total)}s`,
        body: (
          <p>
            {short} is serving traffic. Shipyard watches for restarts and /health{watch}, then marks it live — or rolls the
            images back.
          </p>
        ),
      };
    }
    case 'rolling_back':
      return {
        title: stateWords('rolling_back'),
        body: <p>{prev === null ? `${short} did not hold; the previous images are coming back.` : `${short} did not hold; ${prev} is coming back.`}</p>,
      };
    case 'succeeded':
      return {
        title: `Deployed · ${short} is live`,
        body: <p>{soakSeconds === null ? 'The soak passed.' : `The ${String(soakSeconds)}s soak passed.`} The digests below are what runs.</p>,
      };
    case 'rolled_back': {
      const data = migrated(steps) ? 'The migration that ran stays in the database.' : 'Data unchanged.';
      return {
        title: prev === null ? `${stateWords('rolled_back')} · the previous release is running again` : `${stateWords('rolled_back')} · ${status.app} is running ${prev} again`,
        body: (
          <>
            <p>{data}</p>
            <RefusalLines status={status} />
          </>
        ),
      };
    }
    case 'refused': {
      const check = status.refusal !== null && status.refusal.gate !== 'none' ? status.refusal.gate : null;
      return {
        title:
          check === null ? (
            stateWords('refused')
          ) : (
            <>
              {stateWords('refused')} · <CheckName gate={check} branch={branch} />
            </>
          ),
        body: (
          <>
            <RefusalLines status={status} />
            <p>Nothing ran. {stays}</p>
          </>
        ),
      };
    }
    case 'failed': {
      const failedRow = rows.find((r) => r.state === 'failed');
      const failedStep = failedRow === undefined ? undefined : steps.find((s) => s.name.toLowerCase() === failedRow.key);
      const exit = failedStep?.exitCode ?? null;
      return {
        title:
          failedRow === undefined
            ? stateWords('failed')
            : `${stateWords('failed')} at ${failedRow.label}${exit === null ? '' : ` · exit ${String(exit)}`}`,
        body: <RefusalLines status={status} />,
      };
    }
    case 'cancelled':
      return {
        title: stateWords('cancelled'),
        body: (
          <>
            {status.refusal === null ? null : <p className="shp-deploy-verdict__cause">{status.refusal.message}</p>}
            <p>Nothing more will run for this deploy.</p>
          </>
        ),
      };
  }
}

interface ApprovalProps {
  status: DeployStatus;
  canAct: boolean;
}

/** A held deploy's two acts, for those who may (SHP-REQ-105): approving deploys it; denying ends it. */
function ApprovalActions({ status, canAct }: ApprovalProps) {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [decided, setDecided] = useState<'approve' | 'deny' | null>(null);
  const [denying, setDenying] = useState(false);
  const [error, setError] = useState<RefusalError | null>(null);

  if (!canAct) {
    return <p className="shp-deploy-verdict__meta">Only a deployer or an admin can approve or deny it.</p>;
  }
  if (decided !== null) {
    return (
      <p className="shp-deploy-verdict__meta" role="status">
        {decided === 'approve' ? 'Approved. It starts when the agent picks it up.' : 'Denied. This deploy will not run.'}
      </p>
    );
  }

  const decide = async (action: 'approve' | 'deny') => {
    setBusy(action);
    setError(null);
    try {
      await decideApproval(status.deployId, action);
      setDenying(false);
      setDecided(action);
    } catch (err) {
      setError(
        err instanceof RefusalError
          ? err
          : new RefusalError({ code: 'invalid_request', gate: 'none', message: 'That did not go through.', fix: 'Try again.' }, 0),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {error !== null && !denying ? (
        <Alert tone="danger" title={error.message} dynamic>
          {error.fix}
        </Alert>
      ) : null}
      <div className="shp-alert-actions">
        <Button
          type="button"
          variant="primary"
          loading={busy === 'approve'}
          onClick={() => {
            void decide('approve');
          }}
        >
          {approveVerb(status.sha)}
        </Button>
        <Button
          type="button"
          // Secondary, not danger-ghost: on the verdict banner's accent tint a danger-ghost label
          // measured 4.44:1 in dark (axe, S6). The danger styling stays on the confirming dialog's button.
          variant="secondary"
          onClick={() => {
            setError(null);
            setDenying(true);
          }}
        >
          {VERBS.deny}
        </Button>
      </div>
      <Modal
        open={denying}
        onOpenChange={(open) => {
          if (!open) setDenying(false);
        }}
        title={`${VERBS.deny} ${status.app} at ${sha7(status.sha)}`}
        description="This deploy will not run. It can be requested again later."
        destructive
        footer={
          <FormActions>
            <ModalClose>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </ModalClose>
            <Button
              type="button"
              variant="danger"
              loading={busy === 'deny'}
              onClick={() => {
                void decide('deny');
              }}
            >
              {VERBS.deny}
            </Button>
          </FormActions>
        }
      >
        {error !== null ? (
          <Alert tone="danger" title={error.message} dynamic>
            {error.fix}
          </Alert>
        ) : null}
      </Modal>
    </>
  );
}

function Verdict({ input, canAct, transport, done }: { input: VerdictInput; canAct: boolean; transport: Transport; done: boolean }) {
  const titleId = useId();
  const { status, soak } = input;
  const { title, body } = verdict(input);
  return (
    <section className="shp-deploy-verdict" data-tone={stateTone(status.state)} aria-labelledby={titleId}>
      <h2 id={titleId} className="shp-deploy-verdict__title">
        {title}
      </h2>
      {status.state === 'soaking' && soak !== null ? (
        <div className="shp-deploy-verdict__soak">
          <progress max={soak.total} value={soak.elapsed} aria-label={`Soak, ${String(soak.elapsed)}s of ${String(soak.total)}s`} />
          <span className="shp-deploy-verdict__meta">{String(soak.left)}s left · live after soak</span>
        </div>
      ) : null}
      <div className="shp-deploy-verdict__body">{body}</div>
      {status.state === 'awaiting_approval' && !status.dryRun ? <ApprovalActions status={status} canAct={canAct} /> : null}
      <TransportNote transport={transport} done={done} />
    </section>
  );
}

// ── Facts ───────────────────────────────────────────────────────────────

function Facts({
  status,
  steps,
  before,
  soakSeconds,
  done,
  now,
}: {
  status: DeployStatus;
  steps: readonly DeployStep[];
  before: string | null;
  soakSeconds: number | null;
  done: boolean;
  now: number;
}) {
  const short = sha7(status.sha);
  const prev = before === null ? null : sha7(before);
  const swap = steps.find((s) => s.name.toLowerCase() === 'swap' && s.endedAt !== null);
  const chain =
    status.state === 'rolled_back'
      ? prev === null
        ? `${short} → the previous release`
        : `${prev} → ${short} → ${prev}`
      : prev === null || status.dryRun
        ? short
        : `${prev} → ${short}`;
  const labels = status.images.map((i) => i.migration).filter((m): m is string => typeof m === 'string' && m !== '' && m !== 'none');
  const migrationLabel = labels.length > 0 ? [...new Set(labels)].join(', ') : null;
  const migration = migrated(steps)
    ? `${migrationLabel ?? 'ran'} · migrate step ran`
    : done && !status.dryRun && status.state !== 'refused' && status.state !== 'cancelled'
      ? `${migrationLabel ?? 'none'} · database never changed`
      : migrationLabel;
  const where = [status.requester.repo, status.requester.branch].filter((p): p is string => p !== null && p !== '').join(' · ');

  return (
    <dl className="shp-facts" aria-label="About this deploy">
      <div>
        <dt>Requested by</dt>
        <dd>
          {status.requester.label}
          {where === '' ? null : <span className="shp-facts__sub">{where}</span>}
        </dd>
      </div>
      <div>
        <dt>Started</dt>
        <dd>{done ? dateTime(status.createdAt) : `${span(status.createdAt, now)} ago`}</dd>
      </div>
      {swap?.endedAt !== null && swap?.endedAt !== undefined ? (
        <div>
          <dt>Swapped</dt>
          <dd>{clockTime(swap.endedAt)}</dd>
        </div>
      ) : null}
      {status.endedAt !== null ? (
        <div>
          <dt>Ended</dt>
          <dd>
            {dateTime(status.endedAt)} · took {span(status.createdAt, status.endedAt)}
          </dd>
        </div>
      ) : null}
      <div>
        <dt>Release</dt>
        <dd>{chain}</dd>
      </div>
      {soakSeconds !== null ? (
        <div>
          <dt>Soak from manifest</dt>
          <dd>{String(soakSeconds)}s</dd>
        </div>
      ) : null}
      {migration !== null ? (
        <div>
          <dt>Migration</dt>
          <dd>{migration}</dd>
        </div>
      ) : null}
      {status.schemaRevision !== null ? (
        <div>
          <dt>Schema revision</dt>
          <dd>
            <code className="shp-deploy-mono">{status.schemaRevision}</code>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

// ── Group ───────────────────────────────────────────────────────────────

function Group({ status, done }: { status: DeployStatus; done: boolean }) {
  const group = status.group;
  if (group === undefined) return null;
  const members = [...group.members].sort((a, b) => a.position - b.position);
  const self = members.find((m) => m.app === status.app);
  const next = self === undefined ? undefined : members.find((m) => m.position > self.position);
  const rest = members.filter((m) => m !== self).map((m) => m.app);
  return (
    <Stack gap="12">
      {self?.canary === true ? (
        <Card padding="sm">
          <Stack gap="4">
            <p className="shp-deploy-note">
              Canary of group {group.name}
              {rest.length > 0 ? ` — ${rest.join(', ')} deploy${rest.length === 1 ? 's' : ''} these images next` : ''}
            </p>
            {next !== undefined ? (
              <p className="shp-deploy-note">
                Next in group: {next.app} —{' '}
                {done ? stateWords(next.state) : 'Same images, deployed when this soak passes'}
              </p>
            ) : null}
          </Stack>
        </Card>
      ) : null}
      <Section title="Group" description={`${group.name} — deployed in order, canary first`} surface="plain">
        <DescriptionList>
          {members.map((member) => (
            <DescriptionItem key={member.targetId} term={member.app}>
              <span className="shp-row-meta">
                <Badge tone={memberTone(member)}>{stateWords(member.state)}</Badge>
                {member.canary ? <Badge tone="attention">Canary</Badge> : null}
              </span>
              {member.refusal !== null ? <span className="shp-deploy-muted"> {member.refusal.message}</span> : null}
            </DescriptionItem>
          ))}
        </DescriptionList>
      </Section>
    </Stack>
  );
}

// ── Steps ───────────────────────────────────────────────────────────────

function outputId(key: string): string {
  return `deploy-output-${key}`;
}

function Steps({
  rows,
  steps,
  status,
  done,
  now,
}: {
  rows: readonly StepRow[];
  steps: readonly DeployStep[];
  status: DeployStatus;
  done: boolean;
  now: number;
}) {
  const recorded = new Map(steps.map((s) => [s.name.toLowerCase(), s]));
  // The running step: the last one still open, and only while the deploy runs.
  const runningKey = done ? null : ([...rows].reverse().find((r) => r.state === 'running')?.key ?? null);

  // On a phone the running step must be in view (SHP-T-13.11): scroll it to the middle when the page
  // opens and when the deploy moves to a new step — once per step, and only when it is off screen,
  // so the page never fights a person who has scrolled away to read something else.
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (runningKey === null || scrolledFor.current === runningKey) return;
    scrolledFor.current = runningKey;
    const el = rowRefs.current.get(runningKey);
    if (el === undefined) return;
    const rect = el.getBoundingClientRect();
    const inView = rect.top >= 0 && rect.bottom <= window.innerHeight;
    if (!inView && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
  }, [runningKey]);

  const planned = rows.filter((r) => r.state !== 'skipped');
  const finished = planned.filter((r) => r.state === 'done').length;
  const firstStart = steps[0]?.startedAt ?? status.createdAt;
  const took = span(firstStart, status.endedAt ?? (done ? firstStart : now));
  const summary = `${String(finished)} of ${String(planned.length)} done${steps.length > 0 && took !== '' ? ` · ${took}` : ''}`;

  return (
    <Section title="Steps" description={summary} surface="plain">
      <ol className="shp-steplist" aria-label="Deploy steps">
        {rows.map((r) => {
          const step = recorded.get(r.key);
          const running = r.key === runningKey;
          // Output lives under the running step and a failed one; a finished step keeps one line.
          const showOutput = step !== undefined && (running || r.state === 'failed') && (step.argv.length > 0 || (step.output ?? '') !== '');
          const result = r.state === 'done' && step !== undefined ? lastLine(step.output) : null;
          return (
            <li
              key={r.key}
              ref={(el) => {
                if (el === null) rowRefs.current.delete(r.key);
                else rowRefs.current.set(r.key, el);
              }}
              id={`deploy-step-${r.key}`}
              className="shp-steplist__row shp-deploy-step"
              data-step={r.key}
              data-state={r.state}
              aria-current={running ? 'step' : undefined}
            >
              <PipeNode state={r.state} size="sm" />
              <span className="shp-steplist__label">{r.label}</span>{' '}
              <span className="shp-steplist__state">{STATE_LABEL[r.state]}</span>
              {r.detail === '' ? null : (
                <>
                  {' '}
                  <span className="shp-steplist__time">{r.detail}</span>
                </>
              )}
              {result !== null ? <span className="shp-deploy-step__result">{result}</span> : null}
              {showOutput ? (
                <details className="shp-disclosure shp-deploy-step__output" open id={outputId(r.key)}>
                  <summary>Output</summary>
                  <Stack gap="8">
                    {step.argv.length > 0 ? <code className="shp-deploy-mono">{step.argv.join(' ')}</code> : null}
                    {(step.output ?? '') !== '' ? (
                      <pre className="shp-deploy-output" tabIndex={0} aria-label={`Output of ${r.label}`}>
                        {step.output}
                      </pre>
                    ) : null}
                  </Stack>
                </details>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

// ── Checks, images, Foreman ─────────────────────────────────────────────

function Checks({ status, branch }: { status: DeployStatus; branch: string | null }) {
  return (
    <Section title="Checks">
      {status.gates.length === 0 ? (
        <EmptyState kind="empty" heading="No checks recorded yet" headingLevel={3} size="inline" />
      ) : (
        <DescriptionList>
          {status.gates.map((g) => (
            <DescriptionItem key={g.gate} term={<CheckName gate={g.gate} branch={branch} />}>
              <Badge tone={g.pass ? 'neutral' : 'danger'}>{g.pass ? 'Pass' : 'Fail'}</Badge> {g.reason}
            </DescriptionItem>
          ))}
        </DescriptionList>
      )}
    </Section>
  );
}

function Images({ status }: { status: DeployStatus }) {
  return (
    <Section title="Images" description="from GHCR">
      {status.images.length === 0 ? (
        <EmptyState kind="empty" heading="No images recorded yet" headingLevel={3} size="inline">
          The digests appear once the checks have verified them.
        </EmptyState>
      ) : (
        <DescriptionList>
          {status.images.map((img) => (
            <DescriptionItem key={img.service} term={img.service}>
              <Stack gap="2">
                <code className="shp-deploy-mono">{img.sha}</code>
                <code className="shp-deploy-mono">{img.digest}</code>
                {img.migration !== null && img.migration !== undefined ? <span className="shp-deploy-muted">Migration: {img.migration}</span> : null}
              </Stack>
            </DescriptionItem>
          ))}
        </DescriptionList>
      )}
    </Section>
  );
}

function ForemanRecord({
  status,
  foreman,
  project,
  contextKnown,
  done,
}: {
  status: DeployStatus;
  foreman: ForemanStatus | null;
  project: string | null;
  contextKnown: boolean;
  done: boolean;
}) {
  const stuck = foreman?.stuck === true;
  const posts = foreman?.posts ?? [];
  const to = project ?? 'Foreman';
  let empty: ReactNode;
  if (posts.length === 0) {
    if (contextKnown && project === null) {
      empty = (
        <EmptyState kind="empty" heading="No Foreman mapping" headingLevel={3} size="inline">
          This app has no Foreman project configured.
        </EmptyState>
      );
    } else if (status.dryRun) {
      empty = <p className="shp-deploy-muted">A dry run is never recorded in Foreman.</p>;
    } else if (!done) {
      empty = <p className="shp-deploy-muted">Will post to {to} when it goes live.</p>;
    } else if (status.state === 'succeeded') {
      empty = <p className="shp-deploy-muted">No post recorded for this deploy.</p>;
    } else {
      empty = <p className="shp-deploy-muted">Nothing to post: {to} records releases that went live.</p>;
    }
  }
  return (
    <Section title="Foreman record" description={stuck ? 'A post has been unsent for over an hour.' : undefined}>
      {posts.length === 0 ? (
        empty
      ) : (
        <Stack gap="8">
          {stuck ? (
            <span>
              <Badge tone="danger">Outbox failing</Badge>
            </span>
          ) : null}
          <DescriptionList>
            {posts.map((post) => (
              <DescriptionItem key={post.idempotencyKey} term={post.service}>
                <Badge tone={post.delivered ? 'neutral' : 'attention'}>{post.delivered ? 'Delivered' : 'Pending'}</Badge>{' '}
                {post.delivered ? `Posted to ${to}` : `Will post to ${to}`}
                {post.attempts > 0 ? ` · ${String(post.attempts)} attempt${post.attempts === 1 ? '' : 's'}` : ''}
                {post.lastError !== null ? ` · ${post.lastError}` : ''}
              </DescriptionItem>
            ))}
          </DescriptionList>
        </Stack>
      )}
    </Section>
  );
}

// ── Next actions ────────────────────────────────────────────────────────

function NextActions({
  status,
  runUrl,
  failedKey,
  canAct,
  onDeployAgain,
}: {
  status: DeployStatus;
  runUrl: string | null;
  failedKey: string | null;
  canAct: boolean;
  onDeployAgain: ((app: string, sha: string) => void) | undefined;
}) {
  const fellBack = status.state === 'rolled_back' || status.state === 'failed';
  const showLog = fellBack && failedKey !== null;
  const again = fellBack && canAct && status.kind === 'deploy' && !status.dryRun && onDeployAgain !== undefined;
  return (
    <div role="group" aria-label="Next actions" className="shp-deploy-next">
      <Link asChild>
        <RouterLink to={`/apps/${encodeURIComponent(status.app)}`}>Back to {status.app}</RouterLink>
      </Link>
      {runUrl !== null ? (
        <Link href={runUrl} target="_blank" rel="noreferrer">
          Open CI run ↗
        </Link>
      ) : null}
      {showLog ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            // The failed step's output is already open beneath it: bring it into view and focus it.
            const details = document.getElementById(outputId(failedKey));
            if (details instanceof HTMLDetailsElement) details.open = true;
            const row = document.getElementById(`deploy-step-${failedKey}`);
            if (row !== null && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'start' });
            details?.querySelector('pre')?.focus();
          }}
        >
          View container log
        </Button>
      ) : null}
      {again ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            onDeployAgain(status.app, status.sha);
          }}
        >
          Deploy again
        </Button>
      ) : null}
      <OpenInConstellation path={`app/${status.app}/deploy/${status.deployId}`} />
    </div>
  );
}

// ── The page ────────────────────────────────────────────────────────────

export interface DeployViewProps {
  id: string;
  options?: ProgressOptions;
  /** Pins the clock (tests); otherwise timers tick each second while the deploy runs. */
  now?: number;
  /** The signed-in user may change state: approve, deny, deploy again (SHP-REQ-105). */
  canAct?: boolean;
  /** Opens the normal deploy flow (the dry-run sheet) for this app and SHA. */
  onDeployAgain?: (app: string, sha: string) => void;
}

export function DeployView({ id, options, now: pinnedNow, canAct = false, onDeployAgain }: DeployViewProps) {
  const { status, steps, transport, error, done } = useDeployProgress(id, options);
  const app = status?.app ?? null;
  const context = useDeployAppContext(app);
  const foreman = useForemanPosts(id, status !== null, done);
  const runUrl = useCiRunUrl(app, status?.sha ?? null);
  const now = useClock(status !== null && !done, pinnedNow);

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

  if (status === null) {
    return (
      <Page width="narrow" aria-busy="true">
        <Stack gap="24">
          <span role="status" className="shp-visually-hidden">
            Loading this deploy
          </span>
          <Skeleton variant="text" width="60%" />
          <Skeleton variant="block" height={96} />
          <Skeleton variant="text" lines={6} />
        </Stack>
      </Page>
    );
  }

  const soakSeconds = context?.soakSeconds ?? null;
  const soakOption = soakSeconds === null ? {} : { soakSeconds };
  const branch = context?.defaultBranch ?? status.requester.branch;
  const rows = deploySteps(steps, status.state, { now, ...soakOption });
  const before = liveBefore(status, context?.targets ?? [], context?.liveSha ?? null, !done);
  const soak = soakClock(steps, soakSeconds, now);
  const { title, crumb } = titleFor(status);
  const failedKey = rows.find((r) => r.state === 'failed')?.key ?? null;

  return (
    <Page width="narrow">
      <Stack gap="24">
        <Stack gap="8">
          <Breadcrumb app={status.app} current={crumb} />
          <PageHeader title={title} description={status.dryRun ? 'Dry run — nothing deployed' : undefined} />
        </Stack>
        <Verdict input={{ status, rows, steps, soak, soakSeconds, before, branch }} canAct={canAct} transport={transport} done={done} />
        <Facts status={status} steps={steps} before={before} soakSeconds={soakSeconds} done={done} now={now} />
        <Group status={status} done={done} />
        <PipeLane stages={deployStages(status, steps, { now, ...soakOption })} label="Pipeline" />
        <Steps rows={rows} steps={steps} status={status} done={done} now={now} />
        <Checks status={status} branch={branch} />
        <Images status={status} />
        <ForemanRecord status={status} foreman={foreman} project={context?.foremanProject ?? null} contextKnown={context !== null} done={done} />
        <NextActions status={status} runUrl={runUrl} failedKey={failedKey} canAct={canAct} onDeployAgain={onDeployAgain} />
      </Stack>
    </Page>
  );
}

/** `/deploys/:id`: the page, with the user's role and the deploy sheet behind "Deploy again". */
export function Deploy() {
  const { id = '' } = useParams();
  const can = useCan();
  const navigate = useNavigate();
  const [sheet, setSheet] = useState<SheetAction | null>(null);
  return (
    <>
      <DeployView
        key={id}
        id={id}
        canAct={can}
        onDeployAgain={(app, sha) => {
          setSheet({ kind: 'deploy', app, sha });
        }}
      />
      <DryRunSheet
        open={sheet !== null}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
        action={sheet}
        onStarted={(deployId) => {
          setSheet(null);
          void navigate(`/deploys/${deployId}`);
        }}
      />
    </>
  );
}

/** `/deploys/:id/live`, the old live view's address: the one page now, same deploy (SHP-DA-005). */
export function DeployLiveRedirect() {
  const { id = '' } = useParams();
  return <Navigate to={`/deploys/${encodeURIComponent(id)}`} replace />;
}
