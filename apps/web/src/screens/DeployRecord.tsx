import { Badge, DescriptionItem, DescriptionList, EmptyState, Link, Page, PageHeader, Section, Spinner } from '@d3cloud/ui';
import { useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { RefusalError } from '../lib/api';
import {
  fetchDeployStatus,
  fetchDeploySteps,
  fetchForemanStatus,
  formatRelativeTime,
  isTerminal,
  outcomeLabel,
  outcomeTone,
  shortSha,
  type DeployStatus,
  type DeployStep,
  type ForemanStatus,
} from '../lib/timeline';

/** Deploy record (S6): the request, requester, gates, journal, images and Foreman posts. */

function GithubLink({ sha }: { sha: string }) {
  // The console has no repo mapping of its own; a search is always a valid destination.
  const href = `https://github.com/search?q=${encodeURIComponent(sha)}&type=commits`;
  return (
    <Link href={href} target="_blank" rel="noreferrer">
      {shortSha(sha)}
    </Link>
  );
}

export function DeployRecord() {
  const { id = '' } = useParams();
  const [status, setStatus] = useState<DeployStatus | null>(null);
  const [steps, setSteps] = useState<DeployStep[] | null>(null);
  const [foreman, setForeman] = useState<ForemanStatus | null>(null);
  const [error, setError] = useState<RefusalError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStatus(null);
    setSteps(null);
    setForeman(null);

    fetchDeployStatus(id)
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof RefusalError ? err : new RefusalError({ code: 'invalid_request', gate: 'none', message: 'Could not load this deploy.', fix: 'Try again.' }, 0));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    fetchDeploySteps(id)
      .then((rows) => {
        if (!cancelled) setSteps(rows);
      })
      .catch(() => {
        if (!cancelled) setSteps([]);
      });

    fetchForemanStatus(id)
      .then((f) => {
        if (!cancelled) setForeman(f);
      })
      .catch(() => {
        if (!cancelled) setForeman(null);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <Page width="narrow">
        <Spinner label="Loading this deploy" />
      </Page>
    );
  }

  if (error !== null || status === null) {
    return (
      <Page width="narrow">
        <EmptyState kind="error" heading={error?.message ?? 'This deploy could not be found.'} headingLevel={2}>
          {error?.fix ?? 'Check the address, or go back to the timeline.'}
        </EmptyState>
      </Page>
    );
  }

  const active = !isTerminal(status.state);
  const stuck = foreman?.stuck === true;

  return (
    <Page width="narrow">
      <PageHeader
        title={`${status.app} · ${shortSha(status.sha)}`}
        description={`${status.kind}${status.dryRun ? ' (dry run)' : ''}`}
        actions={
          active ? (
            <Link asChild>
              <RouterLink to={`/deploys/${status.deployId}/live`}>Live view</RouterLink>
            </Link>
          ) : undefined
        }
      />

      <Section title="Request" surface="plain">
        <DescriptionList>
          <DescriptionItem term="App">{status.app}</DescriptionItem>
          <DescriptionItem term="SHA">
            <GithubLink sha={status.sha} />
          </DescriptionItem>
          <DescriptionItem term="Kind">{status.kind}</DescriptionItem>
          <DescriptionItem term="Dry run">{status.dryRun ? 'Yes' : 'No'}</DescriptionItem>
          <DescriptionItem term="State">
            <Badge tone={outcomeTone(status.state)}>{outcomeLabel(status.state)}</Badge>
          </DescriptionItem>
          <DescriptionItem term="Requested">{formatRelativeTime(status.createdAt)}</DescriptionItem>
          <DescriptionItem term="Ended">{status.endedAt !== null ? formatRelativeTime(status.endedAt) : '—'}</DescriptionItem>
          {status.schemaRevision !== null ? <DescriptionItem term="Schema revision">{status.schemaRevision}</DescriptionItem> : null}
        </DescriptionList>
      </Section>

      <Section title="Requester" surface="plain">
        <DescriptionList>
          <DescriptionItem term="Label">{status.requester.label}</DescriptionItem>
          <DescriptionItem term="Repo">{status.requester.repo ?? '—'}</DescriptionItem>
          <DescriptionItem term="Branch">{status.requester.branch ?? '—'}</DescriptionItem>
        </DescriptionList>
      </Section>

      {status.refusal !== null ? (
        <Section title="Refusal">
          <p>{status.refusal.message}</p>
          <p>{status.refusal.fix}</p>
        </Section>
      ) : null}

      {status.group !== undefined ? (
        <Section title="Group" description={`${status.group.name} — deployed in order, canary first`}>
          <DescriptionList>
            {status.group.members.map((member) => (
              <DescriptionItem key={member.targetId} term={member.app}>
                <Badge tone={outcomeTone(member.state)}>{outcomeLabel(member.state)}</Badge>
                {member.canary ? <Badge tone="attention">Canary</Badge> : null}
                {member.refusal !== null ? <span> — {member.refusal.message}</span> : null}
              </DescriptionItem>
            ))}
          </DescriptionList>
        </Section>
      ) : null}

      <Section title="Gates">
        {status.gates.length === 0 ? (
          <EmptyState kind="empty" heading="No gates recorded yet" headingLevel={3} size="inline" />
        ) : (
          <DescriptionList>
            {status.gates.map((g) => (
              <DescriptionItem key={g.gate} term={g.gate}>
                <Badge tone={g.pass ? 'neutral' : 'danger'}>{g.pass ? 'Pass' : 'Fail'}</Badge> {g.reason}
              </DescriptionItem>
            ))}
          </DescriptionList>
        )}
      </Section>

      <Section title="Images">
        {status.images.length === 0 ? (
          <EmptyState kind="empty" heading="No images recorded yet" headingLevel={3} size="inline" />
        ) : (
          <DescriptionList>
            {status.images.map((img) => (
              <DescriptionItem key={img.service} term={img.service}>
                {shortSha(img.sha)} · {img.digest}
                {img.migration !== null && img.migration !== undefined ? ` · ${img.migration}` : ''}
              </DescriptionItem>
            ))}
          </DescriptionList>
        )}
      </Section>

      <Section title="Journal">
        {steps === null ? (
          <Spinner label="Loading the journal" />
        ) : steps.length === 0 ? (
          <EmptyState kind="empty" heading="No steps yet" headingLevel={3} size="inline" />
        ) : (
          <DescriptionList>
            {steps.map((step, i) => (
              <DescriptionItem key={`${step.name}-${String(i)}`} term={step.name}>
                <code>{step.argv.join(' ')}</code>
                {' — '}
                {step.exitCode === null ? 'running' : `exit ${String(step.exitCode)}`}
                {step.output !== null && step.output !== '' ? (
                  <pre>{step.output}</pre>
                ) : null}
              </DescriptionItem>
            ))}
          </DescriptionList>
        )}
      </Section>

      <Section title="Foreman" description={stuck ? 'A post has been unsent for over an hour.' : undefined}>
        {foreman === null || foreman.posts.length === 0 ? (
          <EmptyState kind="empty" heading="No Foreman mapping" headingLevel={3} size="inline">
            This app has no Foreman project configured.
          </EmptyState>
        ) : (
          <>
            {stuck ? <Badge tone="danger">Outbox failing</Badge> : null}
            <DescriptionList>
              {foreman.posts.map((post) => (
                <DescriptionItem key={post.idempotencyKey} term={post.service}>
                  <Badge tone={post.delivered ? 'neutral' : 'attention'}>{post.delivered ? 'Delivered' : 'Pending'}</Badge>
                  {post.attempts > 0 ? ` · ${String(post.attempts)} attempt${post.attempts === 1 ? '' : 's'}` : ''}
                  {post.lastError !== null ? ` · ${post.lastError}` : ''}
                </DescriptionItem>
              ))}
            </DescriptionList>
          </>
        )}
      </Section>
    </Page>
  );
}
