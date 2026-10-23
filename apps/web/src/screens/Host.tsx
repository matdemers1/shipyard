import { EmptyState, Page, PageHeader, Skeleton, Stack } from '@d3cloud/ui';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ageWords, chipFromParams, paramsForChip, useHost, type HostChip } from '../lib/host';
import { AgentStatus, HostView } from './host/HostView';

/**
 * Host (SHP-T-14.7, SHP-REQ-178, SHP-ADR-009): the fourth destination — everything Docker runs on
 * the host, as the agent last reported it: containers grouped by compose project with their tier,
 * volumes, images and disk, at 390 px and on a desktop. The snapshot's age is always on screen and
 * turns into a warning after two report intervals.
 *
 * Read-only (SHP-REQ-181): the page reads `GET /api/host` and nothing else, and offers no action
 * on a container, volume or image. The filter lives in the address (`?tier=` or `?state=`), so a
 * view can be linked.
 */

const FOOTNOTE =
  'Read-only. Deployed is a D3 app Shipyard deploys; Operated is a third-party stack adopted with a manifest; Observed is everything else Docker runs.';

export function Host() {
  const [params, setParams] = useSearchParams();
  const chip = useMemo(() => chipFromParams(params), [params]);
  const data = useHost();
  const onChip = (next: HostChip) => {
    setParams(paramsForChip(next, params), { replace: true });
  };

  const first = data.hosts[0];
  const description =
    first === undefined
      ? 'Everything Docker runs on this host, read-only.'
      : `Everything Docker runs on this host, read-only. Reported ${ageWords(first.reportedAt, data.now)} ago.`;
  const single = data.hosts.length === 1 && first !== undefined;

  return (
    <Page width="wide">
      <Stack gap="24">
        <PageHeader
          title="Host"
          description={description}
          {...(single ? { actions: <span className="shp-host-agent"><AgentStatus snapshot={first} now={data.now} /></span> } : {})}
        />

        {data.status === 'loading' ? (
          <div aria-busy="true">
            <span role="status" className="shp-visually-hidden">
              Loading the host
            </span>
            <Skeleton variant="text" lines={8} />
          </div>
        ) : data.status === 'error' && data.error !== null ? (
          <EmptyState kind={data.error.status === 403 ? 'no-access' : 'error'} heading={data.error.message} headingLevel={2}>
            {data.error.fix}
          </EmptyState>
        ) : data.hosts.length === 0 ? (
          <EmptyState kind="empty" heading="No host inventory yet" headingLevel={2}>
            The agent reports everything Docker runs once it is on version f574b79 or later.
          </EmptyState>
        ) : single ? (
          <HostView snapshot={first} chip={chip} onChip={onChip} now={data.now} headingLevel={2} />
        ) : (
          data.hosts.map((snapshot) => (
            <section key={snapshot.agent.id} aria-labelledby={`host-${snapshot.agent.id}`}>
              <Stack gap="16">
                <h2 id={`host-${snapshot.agent.id}`} className="shp-host-agent-heading">
                  Agent {snapshot.agent.fingerprint}
                </h2>
                <AgentStatus snapshot={snapshot} now={data.now} />
                <HostView snapshot={snapshot} chip={chip} onChip={onChip} now={data.now} headingLevel={3} />
              </Stack>
            </section>
          ))
        )}

        <p className="shp-host-foot">{FOOTNOTE}</p>
      </Stack>
    </Page>
  );
}
