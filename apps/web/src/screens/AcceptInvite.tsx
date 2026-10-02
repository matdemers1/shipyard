import {
  Alert,
  Button,
  CodeInput,
  DescriptionItem,
  DescriptionList,
  FormActions,
  FormField,
  Input,
  Link,
  PasswordInput,
  Spinner,
  Stack,
} from '@d3cloud/ui';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { useParams } from 'react-router-dom';
import { EntryHeading, EntryShell } from '../entry/EntryShell';
import { invites as inviteApi, type InvitePreview } from '../lib/admin';
import { RefusalError, unreachableRefusal } from '../lib/api';

/**
 * Accepting an invitation (`/invite/:token`, public; SHP-REQ-067, SHP-D-067). The link names the
 * email and role; the invitee chooses a display name and a password, adds the authenticator the
 * server generated, and confirms one code — only then does the account exist for sign-in and the
 * invite count as used. Leaving before the code and coming back starts the step again.
 * SHP-T-9.2: in the family's split entry shell, wide.
 */

const MIN_PASSWORD = 12;

type Step =
  | { kind: 'loading' }
  | { kind: 'invalid'; refusal: RefusalError }
  | { kind: 'details'; invite: InvitePreview }
  | { kind: 'totp'; invite: InvitePreview; otpauthUri: string; secret: string }
  | { kind: 'done'; invite: InvitePreview };

function asRefusal(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

export function AcceptInvite() {
  const token = useParams()['token'] ?? '';
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let live = true;
    inviteApi
      .preview(token)
      .then((invite) => {
        if (!live) return;
        if (invite.expired) {
          setStep({
            kind: 'invalid',
            refusal: new RefusalError(
              {
                code: 'conflict',
                gate: 'none',
                message: 'This invite has expired.',
                fix: 'Invites last seven days. Ask whoever invited you for a new one.',
              },
              409,
            ),
          });
        } else setStep({ kind: 'details', invite });
      })
      .catch((error: unknown) => {
        if (live) setStep({ kind: 'invalid', refusal: asRefusal(error) });
      });
    return () => {
      live = false;
    };
  }, [token]);

  const refusalAlert =
    refusal === null ? null : (
      <Alert tone="danger" title={refusal.message} dynamic>
        {refusal.fix}
      </Alert>
    );

  if (step.kind === 'loading') {
    return (
      <EntryShell wide>
        <EntryHeading title="Join Shipyard" focusOnMount={false} />
        <Spinner size="lg" label="Loading the invite" />
      </EntryShell>
    );
  }

  if (step.kind === 'invalid') {
    return (
      <EntryShell wide>
        <EntryHeading title="Join Shipyard" />
        <Alert tone="danger" title={step.refusal.message}>
          {step.refusal.fix}
        </Alert>
      </EntryShell>
    );
  }

  if (step.kind === 'done') {
    return (
      <EntryShell wide>
        <EntryHeading title="Account ready, sign in">{step.invite.email} can now sign in.</EntryHeading>
        <div className="shp-entry__body">
          <Alert tone="success" title="Account ready">
            Sign in with your email, your password and a code from your authenticator.
          </Alert>
          <Link href="/signin" variant="standalone">
            Sign in
          </Link>
        </div>
      </EntryShell>
    );
  }

  if (step.kind === 'totp') {
    const { invite } = step;
    const submitCode = (value: string) => {
      if (inFlight.current || value.length !== 6) return;
      inFlight.current = true;
      setBusy(true);
      setRefusal(null);
      inviteApi
        .confirmTotp(token, value)
        .then(() => {
          setStep({ kind: 'done', invite });
        })
        .catch((error: unknown) => {
          setRefusal(asRefusal(error));
          setCode('');
        })
        .finally(() => {
          setBusy(false);
          inFlight.current = false;
        });
    };
    return (
      <EntryShell wide>
        <EntryHeading title="Add your authenticator" focusOnMount={false}>
          Sign-in needs a code from an authenticator app. Add this account to yours, then enter the code it shows.
        </EntryHeading>
        <div className="shp-entry__body">
          {refusalAlert}
          <Stack
            as="form"
            gap="16"
            noValidate
            onSubmit={(event: SyntheticEvent) => {
              event.preventDefault();
              submitCode(code);
            }}
          >
            <FormField label="On this phone" help="Opens your authenticator app with the account filled in.">
              <Link href={step.otpauthUri} variant="standalone">
                Add to authenticator
              </Link>
            </FormField>
            <FormField label="Or type this setup key" help="Time-based, six digits, every 30 seconds.">
              <code className="shp-secret">{step.secret}</code>
            </FormField>
            <FormField label="Authenticator code" help="Six digits from your authenticator app.">
              <CodeInput
                name="code"
                length={6}
                mode="numeric"
                autoComplete="one-time-code"
                value={code}
                onValueChange={setCode}
                onComplete={submitCode}
                status={refusal === null ? 'idle' : 'error'}
              />
            </FormField>
            <FormActions layout="stack">
              <Button type="submit" variant="primary" size="lg" loading={busy} disabled={code.length !== 6}>
                Confirm and finish
              </Button>
            </FormActions>
          </Stack>
        </div>
      </EntryShell>
    );
  }

  const { invite } = step;
  const submitDetails = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    inviteApi
      .accept(token, displayName.trim(), password)
      .then((r) => {
        setPassword('');
        setCode('');
        setStep({ kind: 'totp', invite, otpauthUri: r.otpauthUri, secret: r.secret });
      })
      .catch((error: unknown) => {
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <EntryShell wide>
      <EntryHeading title="Join Shipyard">You have been invited to this server.</EntryHeading>
      <div className="shp-entry__body">
        {refusalAlert}
        <Stack as="form" gap="16" noValidate onSubmit={submitDetails} aria-label="Accept the invitation">
          <DescriptionList>
            <DescriptionItem term="Email">{invite.email}</DescriptionItem>
            <DescriptionItem term="Role">{invite.role}</DescriptionItem>
          </DescriptionList>
          <FormField label="Display name">
            <Input
              name="displayName"
              autoComplete="name"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
              }}
            />
          </FormField>
          <FormField label="Password" help={`At least ${String(MIN_PASSWORD)} characters.`}>
            <PasswordInput
              name="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          </FormField>
          <FormActions layout="stack">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={busy}
              disabled={displayName.trim() === '' || password.length < MIN_PASSWORD}
            >
              Continue
            </Button>
          </FormActions>
        </Stack>
      </div>
    </EntryShell>
  );
}
