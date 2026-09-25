import {
  Alert,
  AuthLayout,
  Button,
  Card,
  CodeInput,
  FormActions,
  FormField,
  Input,
  Link,
  PasswordInput,
  Stack,
  ThemeSwitch,
} from '@d3cloud/ui';
import { useRef, useState, type SyntheticEvent } from 'react';
import { RefusalError, setup, unreachableRefusal } from '../lib/api';

/**
 * First-run setup (`/setup`, public; SHP-REQ-109). Shown only while the server has no account at
 * all: the first visitor chooses an email, a display name and a password, adds the authenticator
 * the server generated, and confirms one code. That creates the first admin and signs them in.
 * Nothing is written until the code is confirmed, so leaving half-way leaves the server as it was.
 */

const MIN_PASSWORD = 12;

export interface SetupProps {
  /** Called once the admin exists and is signed in; the caller re-reads `/me` and navigates. */
  onSignedIn: () => Promise<void> | void;
  /** Called when the server says setup is closed (someone else claimed it): re-read, go to sign-in. */
  onClosed: () => Promise<void> | void;
}

type Step =
  | { kind: 'details' }
  | { kind: 'totp'; ticket: string; otpauthUri: string; secret: string }
  | { kind: 'closed'; refusal: RefusalError };

function asRefusal(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

export function Setup({ onSignedIn, onClosed }: SetupProps) {
  const [step, setStep] = useState<Step>({ kind: 'details' });
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const [tried, setTried] = useState(false);
  // A ref as well as state: onComplete and the submit button can both fire in one tick.
  const inFlight = useRef(false);

  const footer = <ThemeSwitch label="Theme" size="sm" />;
  const refusalAlert =
    refusal === null ? null : (
      <Alert tone="danger" title={refusal.message} dynamic>
        {refusal.fix}
      </Alert>
    );

  /** A conflict means setup is closed: show it, and offer the way to sign-in. */
  const handle = (error: unknown) => {
    const r = asRefusal(error);
    if (r.code === 'conflict') setStep({ kind: 'closed', refusal: r });
    else setRefusal(r);
  };

  if (step.kind === 'closed') {
    return (
      <AuthLayout title="Set up Shipyard" footer={footer}>
        <Card>
          <Stack gap="16">
            <Alert tone="warning" title={step.refusal.message}>
              {step.refusal.fix}
            </Alert>
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                void onClosed();
              }}
            >
              Go to sign-in
            </Button>
          </Stack>
        </Card>
      </AuthLayout>
    );
  }

  if (step.kind === 'totp') {
    const { ticket } = step;
    const submitCode = (value: string) => {
      if (inFlight.current || value.length !== 6) return;
      inFlight.current = true;
      setBusy(true);
      setRefusal(null);
      setup
        .complete({ ticket, code: value })
        .then(async () => {
          await onSignedIn();
        })
        .catch((error: unknown) => {
          const r = asRefusal(error);
          // An expired or dropped ticket: the details step again, with the reason.
          if (r.code === 'invalid_request') {
            setStep({ kind: 'details' });
            setRefusal(r);
          } else handle(error);
          setCode('');
          setBusy(false);
          inFlight.current = false;
        });
    };
    return (
      <AuthLayout
        title="Add your authenticator"
        description="Signing in to Shipyard needs a code from an authenticator app. Add this account to yours, then enter the code it shows."
        focusOnMount={false}
        footer={footer}
      >
        <Card>
          <Stack
            as="form"
            gap="16"
            noValidate
            onSubmit={(event: SyntheticEvent) => {
              event.preventDefault();
              submitCode(code);
            }}
          >
            {refusalAlert}
            <FormField label="On this phone" help="Opens your authenticator app with the account filled in.">
              <Link href={step.otpauthUri} variant="standalone">
                Add to authenticator
              </Link>
            </FormField>
            <FormField label="Or type this setup key" help="Time-based, six digits, every 30 seconds.">
              <code className="shp-secret" data-testid="setup-secret">
                {step.secret}
              </code>
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
              <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>
                Create account and sign in
              </Button>
            </FormActions>
          </Stack>
        </Card>
      </AuthLayout>
    );
  }

  const tooShort = password.length < MIN_PASSWORD;
  const mismatch = confirm !== password;
  const submitDetails = (event: SyntheticEvent) => {
    event.preventDefault();
    setTried(true);
    if (busy || email.trim() === '' || displayName.trim() === '' || tooShort || mismatch) return;
    setBusy(true);
    setRefusal(null);
    setup
      .start({ email: email.trim(), displayName: displayName.trim(), password })
      .then((started) => {
        setPassword('');
        setConfirm('');
        setCode('');
        setStep({ kind: 'totp', ticket: started.ticket, otpauthUri: started.otpauthUri, secret: started.secret });
      })
      .catch(handle)
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <AuthLayout
      title="Set up Shipyard"
      description="Create the first account. It is an admin, and it signs in with a password and an authenticator code."
      footer={footer}
    >
      <Card>
        <Stack as="form" gap="16" noValidate onSubmit={submitDetails}>
          <Alert tone="info" title="This server has no account yet">
            Until this form is finished, anyone who can reach this address can create the first account. Finish it now.
          </Alert>
          {refusalAlert}
          <FormField label="Email" {...(tried && email.trim() === '' ? { error: 'Enter your email.' } : {})}>
            <Input
              name="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
            />
          </FormField>
          <FormField
            label="Display name"
            {...(tried && displayName.trim() === '' ? { error: 'Enter the name others will see.' } : {})}
          >
            <Input
              name="displayName"
              autoComplete="name"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
              }}
            />
          </FormField>
          <FormField
            label="Password"
            help={`At least ${String(MIN_PASSWORD)} characters.`}
            {...(tried && tooShort ? { error: `Use at least ${String(MIN_PASSWORD)} characters.` } : {})}
          >
            <PasswordInput
              name="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          </FormField>
          <FormField
            label="Confirm password"
            {...(tried && !tooShort && mismatch ? { error: 'The two passwords differ. Type the same one twice.' } : {})}
          >
            <PasswordInput
              name="confirmPassword"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
              }}
            />
          </FormField>
          <FormActions layout="stack">
            <Button type="submit" variant="primary" loading={busy}>
              Continue
            </Button>
          </FormActions>
        </Stack>
      </Card>
    </AuthLayout>
  );
}
