// SHP-T-11.5: a deploy held for approval reaches the phones of everyone who may approve it —
// "<app> is waiting for you" — so a deploy Claude asked for does not wait an hour for someone to open
// the console. Never awaited by the request that held the deploy: a push is best effort.
import { STATE_CHANGING_ROLES } from '../auth/scope.js';
import type { ServiceDeps } from '../deps.js';
import { pushToUsers, type PushResult } from './relay.js';

export async function notifyAwaitingApproval(deps: ServiceDeps, held: { deployId: string; app: string; sha: string }): Promise<PushResult[]> {
  const secret = deps.config.SESSION_SECRET;
  const publicUrl = deps.config.PUBLIC_URL;
  // The link names this Shipyard's host; without one there is nothing for the app to open.
  if (secret === undefined || publicUrl === undefined) return [];
  const approvers = await deps.db.user.findMany({
    where: { disabledAt: null, role: { in: [...STATE_CHANGING_ROLES] } },
    select: { id: true },
  });
  return pushToUsers(
    { db: deps.db, logger: deps.logger, sessionSecret: secret },
    approvers.map((u) => u.id),
    {
      v: 1,
      category: 'shipyard.approval',
      title: `${held.app} is waiting for you`,
      body: `Approve ${held.sha.slice(0, 7)} to go live.`,
      link: `d3constellation://${new URL(publicUrl).host}/shipyard`,
      sentAt: new Date().toISOString(),
    },
    held.deployId,
  );
}
