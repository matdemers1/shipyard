import { Alert, Badge, Button, DataList, DataListRow, Modal, Skeleton } from '@d3cloud/ui';
import type { RolloutItem, RolloutPlan } from '@shipyard/schema';
import { useEffect, useRef, useState } from 'react';
import { RefusalError, unreachableRefusal } from '../lib/api';
import { sha7 } from '../lib/appstatus';
import { planRollout, startRollout } from '../lib/rollouts';

/**
 * Confirms and starts "Roll all" from Home (SHP-T-12.2, SHP-REQ-154). On open it asks the server for
 * the plan — the order it would ship in, Shipyard's own app last, and any refusal it would get now
 * (a lock, a freeze, drift) — so what the deployer confirms is what the server will do. Confirming
 * starts the rollout; there is no rollout dry run, and each app's gates still run on the agent.
 */
export interface RollAllSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The apps Home calls ready to ship, at the SHA each card would ship. */
  items: readonly RolloutItem[];
  /** Called with the rollout ID once it has started. */
  onStarted?: (rolloutId: string) => void;
}

type Phase =
  | { kind: 'planning' }
  | { kind: 'planned'; plan: RolloutPlan }
  | { kind: 'starting'; plan: RolloutPlan }
  | { kind: 'refused'; error: RefusalError; plan: RolloutPlan | null };

function asRefusal(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

export function RollAllSheet({ open, onOpenChange, items, onStarted }: RollAllSheetProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'planning' });
  // `items` is rebuilt on every Home render; the sheet plans once, when it opens.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    setPhase({ kind: 'planning' });
    const current = itemsRef.current;
    if (!open || current.length === 0) return;
    let cancelled = false;
    planRollout(current)
      .then((plan) => {
        if (!cancelled) setPhase({ kind: 'planned', plan });
      })
      .catch((error: unknown) => {
        if (!cancelled) setPhase({ kind: 'refused', error: asRefusal(error), plan: null });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const plan = phase.kind === 'planning' ? null : phase.plan;

  async function onConfirm(): Promise<void> {
    if (plan === null) return;
    setPhase({ kind: 'starting', plan });
    try {
      // The plan's own order and SHAs: exactly what the deployer just read.
      const started = await startRollout(plan.members.map((m) => ({ app: m.app, sha: m.sha })));
      onStarted?.(started.rolloutId);
      onOpenChange(false);
    } catch (error) {
      setPhase({ kind: 'refused', error: asRefusal(error), plan });
    }
  }

  const hasSelf = plan?.members.some((m) => m.self) === true;
  const count = plan?.members.length ?? items.length;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Roll all ${String(count)} apps`}
      description="One at a time, in this order: each app deploys and soaks before the next one starts. Any failure stops the rest, untouched."
      size="lg"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={phase.kind === 'starting'}
            disabled={phase.kind !== 'planned'}
            onClick={() => void onConfirm()}
          >
            Roll all
          </Button>
        </>
      }
    >
      {phase.kind === 'planning' ? (
        <>
          <span role="status" className="shp-visually-hidden">
            Checking the rollout
          </span>
          <Skeleton variant="text" lines={3} />
        </>
      ) : null}

      {plan !== null ? (
        <DataList aria-label="Apps to roll, in order">
          {plan.members.map((member, i) => (
            <DataListRow
              key={member.app}
              title={`${String(i + 1)}. ${member.app}`}
              description={`${sha7(member.liveSha)} → ${sha7(member.sha)}`}
              meta={member.self ? <Badge tone="attention">Shipyard · last</Badge> : undefined}
            />
          ))}
        </DataList>
      ) : null}

      {hasSelf ? (
        <Alert tone="info">
          Shipyard updates itself last, so its restart never interrupts the apps before it. The console reconnects on its own once it
          is back.
        </Alert>
      ) : null}

      {phase.kind === 'refused' ? (
        <Alert tone="danger" title={phase.error.message} dynamic>
          {phase.error.fix}
        </Alert>
      ) : null}
    </Modal>
  );
}
