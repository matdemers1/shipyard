import { Alert, Badge, Button, EmptyState, Link, Modal, Skeleton } from '@d3cloud/ui';
import type { HostContainer, StackUpdateStatus } from '@shipyard/schema';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useLocation, type To } from 'react-router-dom';
import { RefusalError, unreachableRefusal } from '../../lib/api';
import { useMe } from '../../lib/auth';
import {
  candidateTag,
  candidates,
  canUpdateStacks,
  changeWords,
  isStackBusy,
  isUnfixedFailure,
  outcomeTone,
  requesterLine,
  rollbackNote,
  runningTag,
  shortDigest,
  stackUpdateStateWords,
  stacks,
  tracksSentence,
  useStackUpdate,
  versionWords,
  whatHappens,
  type StackPhase,
  type StackView,
} from '../../lib/stacks';
import { formatFeedTime } from '../../lib/timeline';
import {
  AN_EARLIER_UPDATE,
  LOADING_HISTORY,
  NO_UPDATES_YET,
  SHEET_WORDS,
  STACK_HISTORY,
  STACK_NOT_FOUND,
  STACK_ROLL_BACK_CONSEQUENCE,
  STACK_UPDATE_NONE,
  TIER_WORDS,
  UPDATE_HISTORY,
  VERBS,
  UPDATE_SHEET_COLUMNS,
  WHAT_HAPPENS,
  WHAT_RUNS_NOW,
  historyOfWords,
  noUpdatesYetWords,
  rollBackToWords,
  stackChangeWords,
  stackNotFoundWords,
  stackRollBackVerb,
  updateStackTitle,
  updateToLinkWords,
  updateToVerb,
  updatesNoneWords,
} from '../../lib/words';
import { StackOutcome, StackProgress } from './StackProgress';

/**
 * An adopted stack's sheet on Host (SHP-T-16.6, SHP-ADR-010), opened from its group's header or by
 * `?stack=<name>` — and with `&update=1`, the update sheet. On a desktop a panel on the right, on a
 * phone a bottom sheet with its footer pinned, the way the container sheet is.
 *
 * The update sheet (SHP-REQ-194) shows, per service, what runs and what the track resolves to now
 * (tag and short digest; the full digest in its title), the What happens chain from the manifest,
 * the image-only rollback note, and "Update to <tag>" for a deployer and above. A held request says
 * it waits for a deployer (SHP-REQ-199); a running one shows its step; a finished one its result,
 * or the refusal's message and fix verbatim.
 *
 * Whoever opens it sees the stack's newest failure — failed, rolled back or refused — with its
 * message and fix, not only the session that asked (SHP-REQ-200). The history lists every update
 * and rollback, newest first: what moved, how it ended, who asked and who approved, and for one that
 * did not work its message and fix. An earlier success can be rolled back to — the agent takes the
 * digests from its own ledger — after a small confirmation. Every word comes from lib/words.ts.
 */

const HISTORY_LIMIT = 20;

export interface StackSheetProps {
  name: string;
  /** The stack as `GET /api/stacks` reported it; null when no adopted stack has that name. */
  stack: StackView | null;
  mode: 'update' | 'history';
  /** Every container on the host, for the tag a service runs. */
  containers: readonly HostContainer[];
  /** Where the sheet's other mode is. */
  hrefFor: (mode: 'update' | 'history') => To;
  onClose: () => void;
  /** An update was asked for or ended: read the stacks again. */
  onChanged: () => void;
  /** Where this sheet's own request is, so the group header behind it follows its poll. */
  onPhase?: (stack: string, phase: StackPhase) => void;
}

function useHistory(name: string, reloads: number): { items: StackUpdateStatus[] | null; error: RefusalError | null } {
  const [state, setState] = useState<{ items: StackUpdateStatus[] | null; error: RefusalError | null }>({ items: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    stacks
      .history(name, { limit: HISTORY_LIMIT, signal: controller.signal })
      .then((page) => {
        setState({ items: page.items, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((prev) => ({ items: prev.items, error: error instanceof RefusalError ? error : unreachableRefusal() }));
      });
    return () => {
      controller.abort();
    };
  }, [name, reloads]);
  return state;
}

function Facts({ stack }: { stack: StackView }) {
  const tracked = stack.services.filter((s) => s.track !== 'pinned');
  const shown = tracked.length > 0 ? tracked : stack.services;
  return (
    <span className="shp-csheet__facts">
      <span className="shp-csheet__line">
        <Badge size="sm" tone="neutral">
          {TIER_WORDS.operated}
        </Badge>
      </span>
      {shown.map((s) => (
        <span key={s.service} className="shp-csheet__line">
          {tracksSentence(s)}
        </span>
      ))}
    </span>
  );
}

function Version({ tag, digest }: { tag: string | null; digest: string | null }) {
  return (
    <span className="shp-stack-version">
      <span className="shp-stack-version__tag">{versionWords(tag, null)}</span>
      {digest === null ? null : (
        <code className="shp-stack-version__digest" title={digest}>
          {shortDigest(digest)}
        </code>
      )}
    </span>
  );
}

function HistoryList({
  items,
  canRollBack,
  busy,
  onRollBack,
  tagFor,
}: {
  items: readonly StackUpdateStatus[];
  canRollBack: boolean;
  busy: boolean;
  onRollBack: (update: StackUpdateStatus) => void;
  tagFor: (digest: string) => string | null;
}) {
  const now = useMemo(() => new Date(), [items]);
  // What runs now is the newest success: rolling back to it would change nothing.
  const newestSuccess = items.find((u) => u.state === 'succeeded')?.id ?? null;
  return (
    <ul className="shp-stack-history" aria-label={UPDATE_HISTORY}>
      {items.map((u) => {
        const target = u.images[0];
        const offer = canRollBack && u.state === 'succeeded' && u.id !== newestSuccess && target !== undefined;
        const refusal = u.state === 'succeeded' ? null : u.refusal;
        return (
          <li key={u.id} className="shp-stack-history__row">
            <time className="shp-stack-history__time" dateTime={u.createdAt} title={new Date(u.createdAt).toLocaleString()}>
              {formatFeedTime(u.createdAt, now)}
            </time>
            <span className="shp-stack-history__change">{u.kind === 'rollback' ? stackChangeWords('rollback', changeWords(u, tagFor)) : (changeWords(u, tagFor) ?? stackChangeWords('update', null))}</span>
            <span className="shp-stack-history__badge">
              <Badge size="sm" tone={outcomeTone(u.state)}>
                {stackUpdateStateWords(u.state)}
              </Badge>
            </span>
            <span className="shp-stack-history__who">{requesterLine(u)}</span>
            {refusal === null ? null : (
              <span className="shp-stack-history__why">
                <span className="shp-stack-history__message">{refusal.message}</span>
                <span className="shp-stack-history__fix">{refusal.fix}</span>
              </span>
            )}
            {offer ? (
              <span className="shp-stack-history__act">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={rollBackToWords(versionWords(target.tag, target.digest))}
                  disabled={busy}
                  onClick={() => {
                    onRollBack(u);
                  }}
                >
                  {VERBS.rollBack}
                </Button>
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function RollBackConfirm({
  stack,
  update,
  onCancel,
  onConfirm,
}: {
  stack: string;
  update: StackUpdateStatus | null;
  onCancel: () => void;
  onConfirm: (update: StackUpdateStatus) => void;
}) {
  const target = update?.images[0];
  const to = target === undefined ? AN_EARLIER_UPDATE : versionWords(target.tag, target.digest);
  const verb = stackRollBackVerb(stack, to);
  return (
    <Modal
      open={update !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      size="sm"
      title={`${verb}?`}
      description={STACK_ROLL_BACK_CONSEQUENCE}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onCancel}>
            {SHEET_WORDS.cancel}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              if (update !== null) onConfirm(update);
            }}
          >
            {verb}
          </Button>
        </>
      }
    />
  );
}

export function StackSheet({ name, stack, mode, containers, hrefFor, onClose, onChanged, onPhase }: StackSheetProps) {
  const me = useMe();
  const may = canUpdateStacks(me?.role);
  const [reloads, setReloads] = useState(0);
  const ended = useCallback(() => {
    setReloads((n) => n + 1);
    onChanged();
  }, [onChanged]);
  const { phase, run, follow } = useStackUpdate(ended);
  const location = useLocation();
  const navState: unknown = location.state;
  // Accepted: read the stacks again, so the other mode sees it under way.
  const following = phase.kind === 'following';
  useEffect(() => {
    if (following) onChanged();
  }, [following, onChanged]);
  // The header behind the sheet follows this sheet's own poll (its step, or that it ended).
  useEffect(() => {
    onPhase?.(name, phase);
  }, [name, phase, onPhase]);
  const history = useHistory(name, reloads);
  const [confirming, setConfirming] = useState<StackUpdateStatus | null>(null);

  // One already under way when the sheet opens: follow it rather than offer a second.
  const active = stack?.activeUpdate ?? null;
  useEffect(() => {
    if (active !== null && phase.kind === 'idle') follow(active);
  }, [active, phase.kind, follow]);

  const onOpenChange = (next: boolean) => {
    if (!next) onClose();
  };

  if (stack === null) {
    return (
      <Modal open onOpenChange={onOpenChange} title={STACK_NOT_FOUND} closeLabel={SHEET_WORDS.close} size="md">
        <p>{stackNotFoundWords(name)}</p>
      </Modal>
    );
  }

  const busy = isStackBusy(phase);
  const updating = candidates(stack);
  const known = [stack.lastUpdate, stack.activeUpdate, ...(history.items ?? [])].filter((u): u is StackUpdateStatus => u !== null);
  const rows = updating.map((s) => ({ service: s, from: runningTag(s, known, containers, stack.composeProject) }));
  const first = rows[0];
  const to = first?.service.candidate?.tag ?? null;
  const fromWords = first === undefined ? WHAT_RUNS_NOW : versionWords(first.from, first.service.running);
  const hasBackup = (stack.backup ?? null) !== null;
  const tagFor = candidateTag(stack);
  const asked = phase.kind !== 'idle';
  const offerUpdate = may && to !== null && !busy && active === null;

  // The stack's newest failure, for whoever opens the sheet (this session's own result replaces it).
  const lastFailure = !asked && active === null && isUnfixedFailure(stack.lastUpdate) ? stack.lastUpdate : null;

  const progress = (
    <>
      {lastFailure === null ? null : <StackOutcome status={lastFailure} tagFor={tagFor} dynamic={false} />}
      <StackProgress phase={phase} tagFor={tagFor} soakSeconds={stack.soakSeconds} hasBackup={hasBackup} />
    </>
  );

  const closeButton = (
    <span className="shp-csheet__close">
      <Button type="button" variant="ghost" size="sm" onClick={onClose}>
        {SHEET_WORDS.close}
      </Button>
    </span>
  );

  if (mode === 'update') {
    const canSubmit = may && stack.updates === 'digest' && to !== null && !busy && !asked && active === null;
    return (
      <Modal
        open
        onOpenChange={onOpenChange}
        className="shp-csheet shp-ssheet"
        size="lg"
        closeLabel={SHEET_WORDS.close}
        title={updateStackTitle(stack.name)}
        description={<Facts stack={stack} />}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={onClose}>
              {asked ? SHEET_WORDS.done : SHEET_WORDS.cancel}
            </Button>
            {may && to !== null && !asked && active === null ? (
              <Button
                type="button"
                variant="primary"
                disabled={!canSubmit}
                onClick={() => {
                  run({ kind: 'update', stack: stack.name });
                }}
              >
                {updateToVerb(to)}
              </Button>
            ) : null}
          </>
        }
      >
        {closeButton}
        <div className="shp-csheet__body">
          {stack.updates !== 'digest' ? (
            <p className="shp-csheet__muted">{updatesNoneWords(stack.name)}</p>
          ) : rows.length === 0 ? (
            <p className="shp-csheet__muted">{STACK_UPDATE_NONE}</p>
          ) : (
            <>
              <table className="shp-stack-table">
                <thead>
                  <tr>
                    <th scope="col">{UPDATE_SHEET_COLUMNS.service}</th>
                    <th scope="col">{UPDATE_SHEET_COLUMNS.running}</th>
                    <th scope="col">{UPDATE_SHEET_COLUMNS.to}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ service, from }) => (
                    <tr key={service.service}>
                      <th scope="row" className="shp-stack-table__service">
                        {service.service}
                      </th>
                      <td className="shp-stack-table__from">
                        <Version tag={from} digest={service.running} />
                      </td>
                      <td className="shp-stack-table__to">
                        <span className="shp-stack-table__arrow" aria-hidden="true">
                          →
                        </span>
                        <Version tag={service.candidate?.tag ?? null} digest={service.candidate?.digest ?? null} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <section className="shp-stack-section" aria-labelledby={`what-${stack.name}`}>
                <h3 id={`what-${stack.name}`} className="shp-stack-section__title">
                  {WHAT_HAPPENS}
                </h3>
                <ol className="shp-stack-chain">
                  {whatHappens(stack, updating).map((step) => (
                    <li key={step} className="shp-stack-chain__step">
                      <span className="shp-stack-chain__chip">{step}</span>
                    </li>
                  ))}
                </ol>
                <p className="shp-stack-note">{rollbackNote(fromWords, hasBackup)}</p>
              </section>
            </>
          )}
          {progress}
          <p className="shp-csheet__muted">
            <Link asChild>
              <RouterLink to={hrefFor('history')} replace state={navState}>
                {historyOfWords(stack.name)}
              </RouterLink>
            </Link>
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      className="shp-csheet shp-ssheet"
      size="lg"
      closeLabel={SHEET_WORDS.close}
      title={stack.name}
      description={<Facts stack={stack} />}
      {...(offerUpdate
        ? {
            footer: (
              <Link asChild>
                <RouterLink to={hrefFor('update')} replace state={navState} className="shp-ssheet__update">
                  {updateToLinkWords(to)}
                </RouterLink>
              </Link>
            ),
          }
        : {})}
    >
      {closeButton}
      <div className="shp-csheet__body">
        {progress}
        <section className="shp-stack-section" aria-labelledby={`history-${stack.name}`}>
          <h3 id={`history-${stack.name}`} className="shp-stack-section__title">
            {STACK_HISTORY}
          </h3>
          {history.error !== null ? (
            <Alert tone="danger" title={history.error.message}>
              {history.error.fix}
            </Alert>
          ) : null}
          {history.items === null ? (
            history.error === null ? (
              <div aria-busy="true">
                <span role="status" className="shp-visually-hidden">
                  {LOADING_HISTORY}
                </span>
                <Skeleton variant="text" lines={3} />
              </div>
            ) : null
          ) : history.items.length === 0 ? (
            <EmptyState kind="empty" size="inline" heading={NO_UPDATES_YET} headingLevel={4}>
              {noUpdatesYetWords(stack.name)}
            </EmptyState>
          ) : (
            <HistoryList items={history.items} canRollBack={may} busy={busy} onRollBack={setConfirming} tagFor={tagFor} />
          )}
        </section>
      </div>
      <RollBackConfirm
        stack={stack.name}
        update={confirming}
        onCancel={() => {
          setConfirming(null);
        }}
        onConfirm={(update) => {
          setConfirming(null);
          run({ kind: 'rollback', stack: stack.name, toUpdateId: update.id });
        }}
      />
    </Modal>
  );
}
