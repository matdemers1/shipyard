import {
  Alert,
  Badge,
  Button,
  Card,
  Cluster,
  DataList,
  DataListRow,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Page,
  PageHeader,
  Section,
  Select,
  Spinner,
  Stack,
} from '@d3cloud/ui';
import { Copy, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import {
  copyText,
  invites as inviteApi,
  relativeTime,
  shortDate,
  users as userApi,
  type InviteCreated,
  type InviteRole,
  type InviteSummary,
  type UserSummary,
} from '../lib/admin';
import { RefusalError, unreachableRefusal, type Role } from '../lib/api';
import { useCan, useMe } from '../lib/auth';

/**
 * S13 Users (SHP-REQ-067, SHP-REQ-101): who has an account, and how people join — by invitation
 * only, as a deployer or a viewer. The invite link is shown once. An admin changes roles and
 * disables accounts; nobody changes their own. A viewer sees no action (SHP-REQ-105).
 */

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'operator', label: 'Operator' },
  { value: 'deployer', label: 'Deployer' },
  { value: 'viewer', label: 'Viewer' },
];
const INVITE_ROLE_OPTIONS: { value: InviteRole; label: string; description: string }[] = [
  { value: 'deployer', label: 'Deployer', description: 'Can deploy, roll back and change state.' },
  { value: 'viewer', label: 'Viewer', description: 'Can read everything and change nothing.' },
];

function asRefusal(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

function InviteLink({ created, onDismiss }: { created: InviteCreated; onDismiss: () => void }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <Card>
      <Stack gap="16">
        <Alert tone="success" title={`Invite for ${created.email} created`}>
          Send this link to them. It is shown this once, works for seven days, and makes them a {created.role}.
        </Alert>
        <FormField label="Invite link">
          <Stack gap="8">
            <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-all' }}>{created.link}</code>
            <div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<Copy />}
                onClick={() => {
                  void copyText(created.link).then(setCopied);
                }}
              >
                {copied === true ? 'Copied' : copied === false ? 'Copy failed — select it' : 'Copy link'}
              </Button>
            </div>
          </Stack>
        </FormField>
        <FormActions align="start">
          <Button type="button" variant="primary" onClick={onDismiss}>
            Done
          </Button>
        </FormActions>
      </Stack>
    </Card>
  );
}

function InviteForm({ onCreated }: { onCreated: (i: InviteCreated) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('deployer');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    inviteApi
      .create(email.trim(), role)
      .then((i) => {
        setEmail('');
        onCreated(i);
      })
      .catch((error: unknown) => {
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Section title="Invite someone" description="There is no public sign-up: people join only by invitation.">
      <Stack as="form" gap="16" noValidate onSubmit={submit}>
        {refusal === null ? null : (
          <Alert tone="danger" title={refusal.message} dynamic>
            {refusal.fix}
          </Alert>
        )}
        <FormField label="Email">
          <Input
            name="email"
            type="email"
            inputMode="email"
            autoComplete="off"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
        </FormField>
        <FormField label="Role">
          <Select
            name="role"
            options={INVITE_ROLE_OPTIONS}
            value={role}
            onValueChange={(v) => {
              setRole(v === 'viewer' ? 'viewer' : 'deployer');
            }}
          />
        </FormField>
        <FormActions align="start">
          <Button type="submit" variant="primary" icon={<UserPlus />} loading={busy} disabled={email.trim() === ''}>
            Create invite
          </Button>
        </FormActions>
      </Stack>
    </Section>
  );
}

function userDescription(u: UserSummary): string {
  const ways = [u.totpEnrolled ? 'password + TOTP' : 'no authenticator', ...(u.d3authLinked ? ['D3 Auth linked'] : [])];
  return `${u.email} · ${ways.join(' · ')} · joined ${shortDate(u.createdAt)}`;
}

export function Users() {
  const can = useCan();
  const me = useMe();
  const isAdmin = me?.role === 'admin';
  const [list, setList] = useState<UserSummary[] | null>(null);
  const [pending, setPending] = useState<InviteSummary[]>([]);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const [created, setCreated] = useState<InviteCreated | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [u, i] = await Promise.all([userApi.list(), inviteApi.list()]);
      setList(u);
      setPending(i);
      setRefusal(null);
    } catch (error) {
      setRefusal(asRefusal(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (u: UserSummary, patch: { role?: Role; disabled?: boolean }) => {
    setBusyId(u.id);
    setRefusal(null);
    userApi
      .update(u.id, patch)
      .then((row) => {
        setList((prev) => (prev === null ? prev : prev.map((x) => (x.id === row.id ? row : x))));
      })
      .catch((error: unknown) => {
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusyId(null);
      });
  };

  const revokeInvite = (i: InviteSummary) => {
    setBusyId(i.id);
    setRefusal(null);
    inviteApi
      .revoke(i.id)
      .then(() => {
        setPending((prev) => prev.filter((x) => x.id !== i.id));
      })
      .catch((error: unknown) => {
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusyId(null);
      });
  };

  return (
    <Page width="narrow">
      <Stack gap="24">
        <PageHeader
          title="Users"
          description="Who can sign in, and with which role."
          {...(list !== null ? { count: list.length } : {})}
        />
        {refusal === null ? null : (
          <Alert tone="danger" title={refusal.message} dynamic>
            {refusal.fix}
          </Alert>
        )}
        {can && created !== null ? (
          <InviteLink
            created={created}
            onDismiss={() => {
              setCreated(null);
            }}
          />
        ) : null}
        {can && created === null ? (
          <InviteForm
            onCreated={(i) => {
              setCreated(i);
              setPending((prev) => [i, ...prev.filter((x) => x.email !== i.email)]);
            }}
          />
        ) : null}
        {list === null && refusal === null ? <Spinner label="Loading users" /> : null}
        {list !== null ? (
          <Section title="Accounts">
            {list.length <= 1 ? (
              <EmptyState kind="empty" size="inline" heading="Just you" headingLevel={3}>
                Invite a deployer or a viewer above to share this server.
              </EmptyState>
            ) : null}
            <DataList aria-label="Users">
              {list.map((u) => {
                const self = u.id === me?.id;
                const editable = can && isAdmin && !self;
                return (
                  <DataListRow
                    key={u.id}
                    title={self ? `${u.displayName} (you)` : u.displayName}
                    description={userDescription(u)}
                    meta={
                      <Cluster gap="4">
                        <Badge tone="neutral">{u.role}</Badge>
                        {u.disabled ? <Badge tone="danger">Disabled</Badge> : null}
                      </Cluster>
                    }
                    actions={
                      editable ? (
                        <Cluster gap="8">
                          <Select
                            aria-label={`Role for ${u.displayName}`}
                            size="sm"
                            options={ROLE_OPTIONS}
                            value={u.role}
                            disabled={busyId === u.id}
                            onValueChange={(v) => {
                              const role = ROLE_OPTIONS.find((o) => o.value === v)?.value;
                              if (role !== undefined && role !== u.role) update(u, { role });
                            }}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant={u.disabled ? 'secondary' : 'danger-ghost'}
                            loading={busyId === u.id}
                            onClick={() => {
                              update(u, { disabled: !u.disabled });
                            }}
                          >
                            {u.disabled ? 'Enable' : 'Disable'}
                          </Button>
                        </Cluster>
                      ) : undefined
                    }
                  />
                );
              })}
            </DataList>
          </Section>
        ) : null}
        {pending.length > 0 ? (
          <Section title="Pending invites">
            <DataList aria-label="Pending invites">
              {pending.map((i) => (
                <DataListRow
                  key={i.id}
                  title={i.email}
                  description={`${i.role} · invited by ${i.invitedBy} ${relativeTime(i.createdAt)} · expires ${shortDate(i.expiresAt)}`}
                  actions={
                    can ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="danger-ghost"
                        aria-label={`Revoke invite for ${i.email}`}
                        loading={busyId === i.id}
                        onClick={() => {
                          revokeInvite(i);
                        }}
                      >
                        Revoke
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </DataList>
          </Section>
        ) : null}
      </Stack>
    </Page>
  );
}
