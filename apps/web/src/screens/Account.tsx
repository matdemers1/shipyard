import {
  Badge,
  Button,
  DataList,
  DataListRow,
  DescriptionItem,
  DescriptionList,
  FormActions,
  Section,
  SettingsRow,
  Stack,
  ThemeSwitch,
} from '@d3cloud/ui';
import { LogIn, LogOut, Smartphone } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { OIDC_START_PATH, auth, type SignedInSession } from '../lib/api';
import { relativeTime } from '../lib/admin';
import { canChangeState, useAuth, useMe } from '../lib/auth';

/**
 * Settings › People › Your account (S14): who you are, your role, the D3 Auth identity linked to
 * this account, where you are signed in, the theme, and sign-out. Open to every signed-in role.
 * Linking goes through the same OIDC start route: started while signed in, it links rather than
 * signs in (the server decides; accounts are never matched by email). Password and authenticator
 * are set when the account is made (an invite, or first-run setup); there is no screen that
 * changes them yet.
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
    <Section surface="plain" title="Your account" description="Yours alone, whatever your role.">
      <Stack gap="16">
        <Section headingLevel={3} title="You">
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
          headingLevel={3}
          title="Linked D3 Auth identity"
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
        <SignedIn />
        <Section headingLevel={3} title="Appearance">
          <SettingsRow title="Theme" description="This browser only." control={<ThemeSwitch label="Theme" size="sm" />} />
        </Section>
        <Section headingLevel={3} title="Session">
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
    </Section>
  );
}

/** A session's name: the phone's own, or the browser's, or what little is known. */
function sessionTitle(s: SignedInSession): string {
  if (s.deviceName !== null && s.deviceName !== '') return s.deviceName;
  if (s.current) return 'This browser';
  return s.native ? 'D3 Constellation' : 'A browser';
}

/**
 * Where you are signed in (SHP-T-10.4): this browser, others, and D3 Constellation on each device
 * by the name it gave. Ending one signs it out at once — a phone at its next refresh.
 */
function SignedIn() {
  const [sessions, setSessions] = useState<SignedInSession[] | null>(null);
  const [ending, setEnding] = useState<string | null>(null);
  const load = useCallback(() => {
    auth
      .sessions()
      .then(setSessions)
      .catch(() => {
        setSessions([]);
      });
  }, []);
  useEffect(load, [load]);

  return (
    <Section headingLevel={3} title="Signed in" description="Everywhere this account is signed in. End any you don’t recognise.">
      <DataList aria-label="Signed-in sessions" empty="Only here.">
        {(sessions ?? []).map((s) => (
          <DataListRow
            key={s.id}
            title={sessionTitle(s)}
            description={`${s.native ? 'App' : s.method === 'oidc' ? 'D3 Auth' : 'Password'} · signed in ${relativeTime(s.createdAt)}${s.ip === null ? '' : ` · ${s.ip}`}`}
            meta={s.current ? <Badge tone="neutral">This one</Badge> : s.native ? <Smartphone aria-hidden /> : undefined}
            actions={
              s.current ? undefined : (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={ending === s.id}
                  aria-label={`Sign out ${sessionTitle(s)}`}
                  onClick={() => {
                    setEnding(s.id);
                    void auth
                      .revokeSession(s.id)
                      .then(load)
                      .finally(() => {
                        setEnding(null);
                      });
                  }}
                >
                  Sign out
                </Button>
              )
            }
          />
        ))}
      </DataList>
    </Section>
  );
}
