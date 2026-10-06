import { Alert, Badge, Cluster, DataList, DataListRow, EmptyState, Link, Page, PageHeader, Section, Skeleton, Stack } from '@d3cloud/ui';
import type { RolloutStatus } from '@shipyard/schema';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { sha7, stateTone, stateWords } from '../lib/appstatus';
import { isTerminal } from '../lib/progress';
import { rolloutFinished, useRolloutProgress } from '../lib/rollouts';

/**
 * Roll all in progress, `/rollouts/:id` (SHP-T-12.2, SHP-REQ-154): every app of the rollout in the
 * order it ships, each with its state as the agent reports it, linking to that app's own live deploy
 * page for the steps. Follows the rollout with long polls until every app is done.
 */

type Member = RolloutStatus['members'][number];

function memberTone(member: Member): 'neutral' | 'attention' | 'danger' {
  if (member.state === 'succeeded') return 'neutral';
  if (member.state === 'cancelled') return 'neutral';
  if (!isTerminal(member.state)) return 'attention';
  return stateTone(member.state);
}

/** Running, done, or waiting its turn — in words a person uses. */
function memberWords(member: Member, turnHasCome: boolean): string {
  // Locked from the start: the first app whose turn has come waits for the agent, the rest for it.
  if (member.state === 'locked') return turnHasCome ? 'Waiting for the agent' : 'Waiting its turn';
  if (member.state === 'cancelled' && member.refusal?.code === 'rollout_stopped') return 'Not started';
  return stateWords(member.state);
}

function Outcome({ status }: { status: RolloutStatus }) {
  if (status.state === 'succeeded') {
    return (
      <Alert tone="success" title={`All ${String(status.members.length)} apps rolled`}>
        Every app deployed and soaked, one after another.
      </Alert>
    );
  }
  const stopper = status.members.find((m) => m.state !== 'succeeded' && m.refusal?.code !== 'rollout_stopped');
  const untouched = status.members.filter((m) => m.refusal?.code === 'rollout_stopped').map((m) => m.app);
  return (
    <Alert tone="danger" title={stopper === undefined ? 'The rollout stopped' : `The rollout stopped at ${stopper.app}: ${stateWords(stopper.state).toLowerCase()}`}>
      <Stack gap="4">
        {stopper?.refusal !== null && stopper?.refusal !== undefined ? (
          <span>
            {stopper.refusal.message} {stopper.refusal.fix}
          </span>
        ) : null}
        {untouched.length > 0 ? <span>Not touched: {untouched.join(', ')}. Roll again once the failure is fixed.</span> : null}
      </Stack>
    </Alert>
  );
}

export function RolloutProgressView({ id, retryMs }: { id: string; retryMs?: number }) {
  const { status, error } = useRolloutProgress(id, retryMs);

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

  const finished = status !== null && rolloutFinished(status);
  const done = status?.members.filter((m) => m.state === 'succeeded').length ?? 0;

  return (
    <Page width="narrow">
      <Stack gap="24">
        <PageHeader
          title="Roll all"
          description={status === null ? undefined : `${String(done)} of ${String(status.members.length)} done · requested by ${status.requesterLabel}`}
        />
        {status !== null && finished ? <Outcome status={status} /> : null}
        <Section
          title="Apps"
          description={
            status?.members.some((m) => m.self) === true
              ? 'In order: each one soaks before the next starts. Shipyard goes last.'
              : 'In order: each one soaks before the next starts.'
          }
          surface="plain"
        >
          {status === null ? (
            <Skeleton variant="text" lines={3} />
          ) : (
            <DataList aria-label="Apps in this rollout, in order">
              {status.members.map((member, i) => (
                <DataListRow
                  key={member.deployId}
                  title={
                    <Link asChild>
                      <RouterLink to={isTerminal(member.state) ? `/deploys/${member.deployId}` : `/deploys/${member.deployId}/live`}>
                        {`${String(member.position + 1)}. ${member.app}`}
                      </RouterLink>
                    </Link>
                  }
                  description={
                    member.currentStep !== null && !isTerminal(member.state)
                      ? `${sha7(member.sha)} · ${member.currentStep}`
                      : sha7(member.sha)
                  }
                  meta={
                    <Cluster gap="4">
                      {member.self ? <Badge tone="neutral">Shipyard</Badge> : null}
                      <Badge tone={memberTone(member)}>
                        {memberWords(
                          member,
                          status.members.slice(0, i).every((m) => m.state === 'succeeded'),
                        )}
                      </Badge>
                    </Cluster>
                  }
                />
              ))}
            </DataList>
          )}
        </Section>
      </Stack>
    </Page>
  );
}

export function RolloutProgress() {
  const { id = '' } = useParams();
  return <RolloutProgressView id={id} />;
}
