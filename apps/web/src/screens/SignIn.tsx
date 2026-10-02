import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Alert, Button, CodeInput, FormActions, FormField, Input, PasswordInput, Stack } from '@d3cloud/ui';
import { EntryHeading, EntryNotes, EntryShell } from '../entry/EntryShell';
import { SignInWithD3Auth } from '../entry/SignInWithD3Auth';
import { RefusalError, auth, unreachableRefusal } from '../lib/api';

/**
 * S1 Sign in (SHP-REQ-001): email and password, then the authenticator code; or Sign in with
 * D3 Auth, offered only when the server says the OIDC client exists. The password form never
 * depends on D3 Auth, so it still works when D3 Auth is the thing that is down.
 *
 * Every refusal shows the server's message and its fix — never a bare "error". SHP-T-9.2: in the
 * family's split entry shell, which also carries the theme choice (SHP-REQ-055).
 */

export interface SignInProps {
  /** Called once the TOTP step has made a session; the caller re-reads `/me` and navigates. */
  onSignedIn: () => Promise<void> | void;
}

type Step = 'password' | 'totp';

function asRefusal(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

export function SignIn({ onSignedIn }: SignInProps) {
  const [step, setStep] = useState<Step>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const [d3auth, setD3auth] = useState(false);
  // A ref as well as state: onComplete and the Verify button can both fire in one tick.
  const inFlight = useRef(false);

  useEffect(() => {
    let live = true;
    auth
      .methods()
      .then((methods) => {
        if (live) setD3auth(methods.d3auth);
      })
      .catch(() => {
        // Not knowing is the same as "not available": the password form is always there.
        if (live) setD3auth(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const submitPassword = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy) return;
    setRefusal(null);
    setBusy(true);
    auth
      .login({ email, password })
      .then(() => {
        setPassword('');
        setCode('');
        setStep('totp');
      })
      .catch((error: unknown) => {
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const submitCode = (value: string) => {
    if (inFlight.current || value.length !== 6) return;
    inFlight.current = true;
    setRefusal(null);
    setBusy(true);
    auth
      .totp({ code: value })
      .then(async () => {
        await onSignedIn();
      })
      .catch((error: unknown) => {
        const r = asRefusal(error);
        setRefusal(r);
        setCode('');
        setBusy(false);
        inFlight.current = false;
      });
  };

  const startOver = () => {
    setRefusal(null);
    setCode('');
    setStep('password');
  };

  const refusalAlert =
    refusal === null ? null : (
      <Alert tone="danger" title={refusal.message} dynamic>
        {refusal.fix}
      </Alert>
    );

  if (step === 'totp') {
    return (
      <EntryShell>
        <EntryHeading title="Sign in" focusOnMount={false}>
          One more step for <strong>{email}</strong>: the code from your authenticator app.
        </EntryHeading>
        <div className="shp-entry__body">
          {refusalAlert}
          <Stack
            as="form"
            gap="16"
            noValidate
            aria-label="Enter your authenticator code"
            onSubmit={(event: SyntheticEvent) => {
              event.preventDefault();
              submitCode(code);
            }}
          >
            <FormField label="Authenticator code" help="Six digits from your authenticator app.">
              <CodeInput
                name="code"
                length={6}
                mode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onValueChange={setCode}
                onComplete={submitCode}
                status={refusal === null ? 'idle' : 'error'}
              />
            </FormField>
            <FormActions layout="stack">
              <Button type="submit" variant="primary" size="lg" loading={busy} disabled={code.length !== 6}>
                Verify
              </Button>
            </FormActions>
          </Stack>
        </div>
        <EntryNotes row>
          <button type="button" className="shp-entry-link shp-entry-link--quiet" onClick={startOver} disabled={busy}>
            Use a different account
          </button>
        </EntryNotes>
      </EntryShell>
    );
  }

  return (
    <EntryShell>
      <EntryHeading title="Sign in">Deploys for this host&apos;s compose stacks.</EntryHeading>
      <div className="shp-entry__body">
        {refusalAlert}
        <Stack as="form" gap="16" noValidate onSubmit={submitPassword} aria-label="Sign in with your password">
          <FormField label="Email">
            <Input
              name="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
            />
          </FormField>
          <FormField label="Password">
            <PasswordInput
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          </FormField>
          <FormActions layout="stack">
            <Button type="submit" variant="primary" size="lg" loading={busy}>
              Continue
            </Button>
          </FormActions>
        </Stack>
        {/* Below the password form, and only when the server has the D3 Auth client. */}
        <SignInWithD3Auth offered={d3auth} />
      </div>
      <EntryNotes>
        <p>New here? Accounts are by invitation — open the link you were sent.</p>
      </EntryNotes>
    </EntryShell>
  );
}
