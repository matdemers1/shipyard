import { PageHeader, Stack } from '@d3cloud/ui';
import { useCan } from '../../lib/auth';
import { Account } from '../Account';
import { Users } from '../Users';

/**
 * Settings › People (SHP-ADR-006): the users and invites, which need a state-changing role as the
 * old Users screen did, and your own account, which every signed-in role has. A viewer lands here
 * when opening Settings, so the page is never a refusal for them — it is just their account.
 */
export function PeopleSection() {
  const can = useCan();
  return (
    <Stack gap="24">
      <PageHeader
        title="People"
        description={can ? 'Who can sign in and with which role, and your own account.' : 'Your account: who you are, where you are signed in, and how the console looks.'}
      />
      {can ? <Users /> : null}
      <Account />
    </Stack>
  );
}
