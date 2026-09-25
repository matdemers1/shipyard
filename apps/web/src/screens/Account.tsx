import {
  Badge,
  Button,
  DescriptionItem,
  DescriptionList,
  FormActions,
  Page,
  PageHeader,
  Section,
  Stack,
} from '@d3cloud/ui';
import { LogIn, LogOut } from 'lucide-react';
import { useEffect, useState } from 'react';
import { OIDC_START_PATH, auth } from '../lib/api';
import { canChangeState, useAuth, useMe } from '../lib/auth';

/**
 * S14 Account: who you are, your role, the D3 Auth identity linked to this account, and sign-out.
 * Linking goes through the same OIDC start route: started while signed in, it links rather than
 * signs in (the server decides; accounts are never matched by email).
 */
export function Account() {
  const me = useMe();
  const { signOut } = useAuth();
  const [d3auth, setD3auth] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let live = true;
    auth
      .methods()
      .then((m) => {
        if (live) setD3auth(m.d3auth);
      })
      .catch(() => {
        if (live) setD3auth(false);
      });
    return () => {
      live = false;
    };
  }, []);

  if (me === null) return null;
  const linked = me.identities;

  return (
    <Page width="narrow">
      <Stack gap="24">
        <PageHeader title="Account" />
        <Section title="You">
          <DescriptionList>
            <DescriptionItem term="Name">{me.displayName}</DescriptionItem>
            <DescriptionItem term="Email">{me.email}</DescriptionItem>
            <DescriptionItem term="Role">
              <Badge tone="neutral">{me.role}</Badge>{' '}
              {canChangeState(me.role) ? 'Can deploy and change state.' : 'Can read; cannot change anything.'}
            </DescriptionItem>
          </DescriptionList>
        </Section>
        <Section
          title="Sign in with D3 Auth"
          description={
            linked.length > 0
              ? 'This account can also be signed in to through D3 Auth.'
              : 'No D3 Auth identity is linked to this account.'
          }
        >
          <Stack gap="16">
            {linked.length > 0 ? (
              <DescriptionList>
                {linked.map((identity) => (
                  <DescriptionItem key={identity.issuer} term="Issuer">
                    <code>{identity.issuer}</code>
                  </DescriptionItem>
                ))}
              </DescriptionList>
            ) : null}
            {d3auth && linked.length === 0 ? (
              <FormActions align="start">
                <Button
                  type="button"
                  variant="secondary"
                  icon={<LogIn />}
                  onClick={() => {
                    window.location.assign(OIDC_START_PATH);
                  }}
                >
                  Link D3 Auth
                </Button>
              </FormActions>
            ) : null}
          </Stack>
        </Section>
        <Section title="Session">
          <FormActions align="start">
            <Button
              type="button"
              variant="secondary"
              icon={<LogOut />}
              loading={signingOut}
              onClick={() => {
                setSigningOut(true);
                void signOut();
              }}
            >
              Sign out
            </Button>
          </FormActions>
        </Section>
      </Stack>
    </Page>
  );
}
