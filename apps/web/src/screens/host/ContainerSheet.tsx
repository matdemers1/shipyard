import { Badge, Button, Modal, StatusDot } from '@d3cloud/ui';
import type { HostContainer, LifecycleVerb } from '@shipyard/schema';
import { useState } from 'react';
import { canAct, canReadLogs, containerRequest, containerVerbs, isBusy, targetFor, useAction } from '../../lib/actions';
import { useMe } from '../../lib/auth';
import { containerStatus, cpuWords, isDeployedTier, memoryWords, restartWords } from '../../lib/host';
import { LIFECYCLE_VERB_WORDS, TIER_WORDS } from '../../lib/words';
import { ActionProgress } from './ActionProgress';
import { LogsViewer } from './LogsViewer';
import { StopConfirm } from './StopConfirm';

/**
 * A container's sheet (SHP-T-15.7, SHP-REQ-184/185/188/189/192), opened from its Host row or by
 * `/host?container=<id>`: what it is (tier, state, service, image, use), its lifecycle actions when
 * its tier and the reader's role allow them, and its logs. On a desktop it is a panel on the right
 * beside the list; on a phone a bottom sheet, the way every sheet in the console is.
 *
 * Observed containers get no action at all (SHP-REQ-185); a viewer sees none either. Stop asks
 * first and is only ever here (SHP-REQ-188). The footer says the logs are redacted on the host and
 * never stored, and that opening them is audited (SHP-REQ-192).
 */

export const LOGS_NOTE = 'Redacted on the host before they leave it, and never stored. Opening these logs is recorded in the audit log.';

const HINT = 'Restart and Recreate never change the image.';

function Facts({ container }: { container: HostContainer }) {
  const status = containerStatus(container);
  const where = container.compose === null ? null : `${container.compose.project} · ${container.compose.service}`;
  return (
    <span className="shp-csheet__facts">
      <span className="shp-csheet__line">
        <Badge size="sm" tone={isDeployedTier(container.tier) ? 'attention' : 'neutral'}>
          {TIER_WORDS[container.tier]}
        </Badge>
        <StatusDot tone={status.tone} size="sm">
          {status.words}
        </StatusDot>
        {where === null ? null : <span>{where}</span>}
        <code className="shp-csheet__image">{container.image}</code>
      </span>
      <span className="shp-csheet__line">
        {restartWords(container.restartCount)} · {cpuWords(container.stats)} CPU · {memoryWords(container.stats)}
      </span>
    </span>
  );
}

function Actions({ container }: { container: HostContainer }) {
  const me = useMe();
  const { phase, run } = useAction();
  const [confirmStop, setConfirmStop] = useState(false);
  const target = targetFor(container.tier, container.app);
  const service = container.compose?.service ?? null;

  if (target === null || service === null) {
    return <p className="shp-csheet__muted">Observed: Shipyard only watches this container. Adopt its stack to start, stop or restart it here.</p>;
  }
  if (!canAct(me?.role)) return null;

  const busy = isBusy(phase);
  const ask = (verb: LifecycleVerb) => {
    const body = containerRequest(container, verb);
    if (body !== null) run(body);
  };
  const verbs = containerVerbs(container);

  return (
    <div className="shp-csheet__actions">
      <div className="shp-csheet__buttons" role="group" aria-label="Actions">
        {verbs.map((verb) =>
          verb === 'stop' ? (
            <Button
              key={verb}
              type="button"
              variant="danger-ghost"
              disabled={busy}
              onClick={() => {
                setConfirmStop(true);
              }}
            >
              {LIFECYCLE_VERB_WORDS.stop}
            </Button>
          ) : (
            <Button
              key={verb}
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                ask(verb);
              }}
            >
              {LIFECYCLE_VERB_WORDS[verb]}
            </Button>
          ),
        )}
        {verbs.includes('restart') ? <span className="shp-csheet__hint">{HINT}</span> : null}
      </div>
      <ActionProgress phase={phase} />
      <StopConfirm
        open={confirmStop}
        onOpenChange={setConfirmStop}
        name={container.name}
        target={target}
        service={service}
        onConfirm={() => {
          ask('stop');
        }}
      />
    </div>
  );
}

export interface ContainerSheetProps {
  /** The container to show; null when the address names one this host does not have. */
  container: HostContainer | null;
  open: boolean;
  onClose: () => void;
}

export function ContainerSheet({ container, open, onClose }: ContainerSheetProps) {
  const me = useMe();
  const onOpenChange = (next: boolean) => {
    if (!next) onClose();
  };

  if (container === null) {
    return (
      <Modal open={open} onOpenChange={onOpenChange} title="Container not found" closeLabel="Close" size="md">
        <p>This host has no container with that ID any more. It may have been removed or recreated since the link was made.</p>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      className="shp-csheet"
      size="lg"
      closeLabel="Close"
      title={container.name}
      description={<Facts container={container} />}
      footer={<p className="shp-csheet__note">{LOGS_NOTE}</p>}
    >
      <span className="shp-csheet__close">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </span>
      <div className="shp-csheet__body">
        <Actions key={container.id} container={container} />
        <LogsViewer key={container.id} containerId={container.id} allowed={canReadLogs(me?.role)} />
      </div>
    </Modal>
  );
}
