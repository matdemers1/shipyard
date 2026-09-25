import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import {
  Alert,
  AuthLayout,
  Button,
  Card,
  CodeInput,
  FormActions,
  FormField,
  Input,
  PasswordInput,
  Stack,
  ThemeSwitch,
} from '@d3cloud/ui';
import { LogIn } from 'lucide-react';
import { OIDC_START_PATH, RefusalError, auth, unreachableRefusal } from '../lib/api';

/**
 * S1 Sign in (SHP-REQ-001): email and password, then the authenticator code; or Sign in with
 * D3 Auth, offered only when the server says the OIDC client exists. The password form never
 * depends on D3 Auth, so it still works when D3 Auth is the thing that is down.
 *
 * Every refusal shows the server's message and its fix — never a bare "error".
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

  // The sign-in page has no shell, so the theme choice lives here (SHP-REQ-055).
  const themeFooter = <ThemeSwitch label="Theme" size="sm" />;

  if (step === 'totp') {
    return (
      <AuthLayout
        title="Sign in to Shipyard"
        description={`One more step for ${email}: the code from your authenticator app.`}
        focusOnMount={false}
        footer={themeFooter}
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
            <FormActions
              layout="stack"
              leading={
                <Button type="button" variant="ghost" onClick={startOver} disabled={busy}>
                  Use a different account
                </Button>
              }
            >
              <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>
                Verify
              </Button>
            </FormActions>
          </Stack>
        </Card>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Sign in to Shipyard"
      description="Deploys for this host's compose stacks."
      footer={themeFooter}
    >
      <Stack gap="16">
        <Card>
          <Stack as="form" gap="16" noValidate onSubmit={submitPassword}>
            {refusalAlert}
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
              <Button type="submit" variant="primary" loading={busy}>
                Continue
              </Button>
            </FormActions>
          </Stack>
        </Card>
        {d3auth ? (
          // A top-level navigation, not a fetch: the server answers with a redirect to D3 Auth.
          <Button
            type="button"
            variant="secondary"
            icon={<LogIn />}
            onClick={() => {
              window.location.assign(OIDC_START_PATH);
            }}
          >
            Sign in with D3 Auth
          </Button>
        ) : null}
      </Stack>
    </AuthLayout>
  );
}
