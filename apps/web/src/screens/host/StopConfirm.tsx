import { Alert, Button, Modal } from '@d3cloud/ui';
import type { ActionTarget } from '@shipyard/schema';
import { LIFECYCLE_VERB_WORDS } from '../../lib/words';

/**
 * "Stop <name>?" (SHP-T-15.7, SHP-REQ-188): the one lifecycle verb that asks first. It says what
 * stops and that nothing starts it again by itself, and that stop lives only here — an API token,
 * and so a Claude session, can restart or recreate but never stop.
 */

export const STOP_CONSOLE_ONLY = 'Stop is console-only: a Claude session can restart or recreate, never stop.';

/** What stopping a service does, in the words of the target it belongs to. */
export function stopConsequence(target: ActionTarget, service: string): string {
  const what = `${service} of ${target.name} stops until it is started again. Shipyard won't start it for you`;
  return target.kind === 'app' ? `${what}, and the next deploy of ${target.name} will start it.` : `${what}.`;
}

export interface StopConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  target: ActionTarget;
  service: string;
  onConfirm: () => void;
}

export function StopConfirm({ open, onOpenChange, name, target, service, onConfirm }: StopConfirmProps) {
  const verb = `${LIFECYCLE_VERB_WORDS.stop} ${name}`;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      destructive
      size="md"
      title={`${verb}?`}
      description={stopConsequence(target, service)}
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {verb}
          </Button>
        </>
      }
    >
      <Alert tone="warning">{STOP_CONSOLE_ONLY}</Alert>
    </Modal>
  );
}
