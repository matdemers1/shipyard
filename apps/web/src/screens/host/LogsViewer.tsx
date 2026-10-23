import { Alert, Button, Spinner } from '@d3cloud/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LOGS_FOLLOW_SECONDS, LOGS_TAIL, followClock, logTime, useLogs, type Logs } from '../../lib/actions';

/**
 * A container's logs in the sheet (SHP-T-15.7, SHP-ADR-011, SHP-REQ-189): monospace, newest at the
 * bottom, following the bottom while it is there and offering "Jump to latest" when scrolled up;
 * stderr in the warning tone. The last 200 lines, and — while Follow is on — new ones for at most
 * five minutes, with the time left on the toggle. Closing the sheet, turning Follow off or hiding
 * the page closes the stream and the session.
 */

/** Within this many pixels of the bottom counts as "at the bottom". */
const BOTTOM_SLACK_PX = 24;

export const ROLE_CANT_READ_LOGS = "Your role can't read logs";

function FollowToggle({ logs }: { logs: Logs }) {
  const following = logs.mode === 'follow';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (logs.followEndsAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [logs.followEndsAt]);
  const left = logs.followEndsAt === null ? null : Math.min(LOGS_FOLLOW_SECONDS, (logs.followEndsAt - now) / 1000);
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      pressed={following}
      onClick={() => {
        logs.setFollow(!following);
      }}
    >
      {following ? (left === null ? 'Following' : `Following · ${followClock(left)} left`) : 'Follow'}
    </Button>
  );
}

function Lines({ logs }: { logs: Logs }) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Newest at the bottom: keep it in view while the reader is there, and leave them be when not.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el !== null && atBottom) el.scrollTop = el.scrollHeight;
  }, [logs.lines, atBottom]);

  const jump = () => {
    const el = scroller.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  };

  return (
    <div className="shp-logs__frame">
      <div
        ref={scroller}
        className="shp-logs__scroll"
        // A scrolling region must be reachable from the keyboard (axe: scrollable-region-focusable).
        tabIndex={0}
        role="log"
        aria-label="Log lines"
        // A stream of up to 2000 lines read aloud as they arrive helps nobody; the region is browsable.
        aria-live="off"
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX);
        }}
      >
        <ol className="shp-logs__lines">
          {logs.lines.map(({ key, line }) => (
            <li key={key} className="shp-logs__line" data-stream={line.stream}>
              <span className="shp-logs__time">{logTime(line.at)}</span>
              <span className="shp-logs__text">{line.text}</span>
            </li>
          ))}
        </ol>
      </div>
      {atBottom ? null : (
        <span className="shp-logs__jump">
          <Button type="button" size="sm" variant="secondary" onClick={jump}>
            Jump to latest
          </Button>
        </span>
      )}
    </div>
  );
}

function Body({ logs }: { logs: Logs }) {
  const { status } = logs;
  if (status.kind === 'error') {
    if (status.error.code === 'agent_too_old') {
      return (
        <div className="shp-logs__state" role="status">
          <p className="shp-logs__state-head">The agent can&apos;t stream logs yet</p>
          <p>{status.error.message}</p>
          <p className="shp-logs__muted">{status.error.fix}</p>
        </div>
      );
    }
    return (
      <>
        {logs.lines.length > 0 ? <Lines logs={logs} /> : null}
        <Alert tone="danger" title={status.error.message} dynamic>
          {status.error.fix}
        </Alert>
      </>
    );
  }
  if (logs.lines.length === 0) {
    if (status.kind === 'loading' || (status.kind === 'streaming' && logs.mode !== 'stopped')) {
      return (
        <p className="shp-logs__state" role="status">
          <Spinner size="sm" /> Loading logs
        </p>
      );
    }
    return <p className="shp-logs__state">No output</p>;
  }
  return <Lines logs={logs} />;
}

export function LogsViewer({ containerId, allowed }: { containerId: string; allowed: boolean }) {
  const logs = useLogs(containerId, allowed);
  return (
    <section className="shp-logs" aria-labelledby="shp-logs-heading">
      <div className="shp-logs__head">
        <h3 id="shp-logs-heading" className="shp-logs__title">
          Logs
        </h3>
        <span className="shp-logs__muted">last {LOGS_TAIL} lines</span>
        {allowed ? (
          <span className="shp-logs__follow">
            <FollowToggle logs={logs} />
          </span>
        ) : null}
      </div>
      {allowed ? <Body logs={logs} /> : <p className="shp-logs__state">{ROLE_CANT_READ_LOGS}</p>}
    </section>
  );
}
