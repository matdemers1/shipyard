import {
  Alert,
  Badge,
  Button,
  Checkbox,
  DescriptionItem,
  DescriptionList,
  FormActions,
  FormField,
  Input,
  Modal,
  Page,
  PageHeader,
  PasswordInput,
  Section,
  Spinner,
  Stack,
} from '@d3cloud/ui';
import type { D3AuthSettings, D3AuthTestResult } from '@shipyard/schema';
import { Copy, Download, PlugZap, Power, Save } from 'lucide-react';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { copyText, shortDate } from '../lib/admin';
import { RefusalError, unreachableRefusal } from '../lib/api';
import { downloadManifest, settings as settingsApi } from '../lib/settings';
import { AlertEmailSettings } from './AlertEmailSettings';

/**
 * Settings (SHP-T-6.8, SHP-REQ-110): configure Sign in with D3 Auth without editing server files.
 * Admin-only — the nav shows it only to an admin, the route refuses anyone else, and so does the
 * server. The client secret is write-only: the screen only ever learns whether one is stored.
 * Password + authenticator sign-in is unaffected by anything here (SHP-REQ-001). Alert email
 * (SHP-T-6.9) is its own section, in AlertEmailSettings.tsx.
 */

function asRefusal(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      icon={<Copy />}
      onClick={() => {
        void copyText(text).then(setCopied);
      }}
    >
      {copied === true ? 'Copied' : copied === false ? 'Copy failed — select it' : label}
    </Button>
  );
}

function Status({ s }: { s: D3AuthSettings }) {
  if (s.source === 'none') {
    return (
      <p>
        <Badge tone="neutral">Off</Badge> The sign-in page offers password and authenticator only.
      </p>
    );
  }
  if (s.available) {
    return (
      <p>
        <Badge tone="neutral">On</Badge> The sign-in page offers Sign in with D3 Auth.
      </p>
    );
  }
  return (
    <Alert tone="warning" title="Configured, but the D3 Auth button is off">
      {s.problem ?? 'D3 Auth is not available right now.'}
    </Alert>
  );
}

function TestResult({ result }: { result: D3AuthTestResult }) {
  if (result.ok) {
    return (
      <Alert tone="success" title="The issuer answered" dynamic>
        Its discovery document names {result.discoveredIssuer ?? result.issuer}, with sign-in, token and signing-key endpoints.
      </Alert>
    );
  }
  return (
    <Alert tone="danger" title="The issuer did not pass" dynamic>
      {result.error ?? 'Discovery failed.'}
    </Alert>
  );
}

function EnvReadOnly({ s }: { s: D3AuthSettings }) {
  return (
    <Stack gap="16">
      <Alert tone="info" title="Set in server.env">
        The D3AUTH_* variables in server.env win over this screen. To change them, edit server.env and restart; to manage
        D3 Auth here instead, remove all three there.
      </Alert>
      <DescriptionList>
        <DescriptionItem term="Issuer">{s.issuer ?? 'Not set'}</DescriptionItem>
        <DescriptionItem term="Client ID">{s.clientId ?? 'Not set'}</DescriptionItem>
        <DescriptionItem term="Client secret">{s.clientSecretSet ? 'Set' : 'Not set'}</DescriptionItem>
      </DescriptionList>
    </Stack>
  );
}

type Done = 'saved' | 'off';

function D3AuthForm({ s, onDone }: { s: D3AuthSettings; onDone: (next: D3AuthSettings, what: Done) => void }) {
  const [issuer, setIssuer] = useState(s.issuer ?? '');
  const [clientId, setClientId] = useState(s.clientId ?? 'shipyard');
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | 'off' | null>(null);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const [test, setTest] = useState<D3AuthTestResult | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  const save = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy !== null) return;
    setBusy('save');
    setRefusal(null);
    settingsApi
      .saveD3auth({
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        ...(secret !== '' ? { clientSecret: secret } : {}),
        ...(secret === '' && clearSecret ? { clearSecret: true } : {}),
      })
      .then((next) => {
        setSecret('');
        setClearSecret(false);
        onDone(next, 'saved');
      })
      .catch((error: unknown) => {
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const runTest = () => {
    if (busy !== null) return;
    setBusy('test');
    setRefusal(null);
    setTest(null);
    settingsApi
      .testD3auth(issuer)
      .then(setTest)
      .catch((error: unknown) => {
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const turnOff = () => {
    setBusy('off');
    setRefusal(null);
    settingsApi
      .clearD3auth()
      .then((next) => {
        setConfirmOff(false);
        onDone(next, 'off');
      })
      .catch((error: unknown) => {
        setConfirmOff(false);
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const secretHelp = !s.canStoreSecret
    ? 'SESSION_SECRET is unset in server.env, so a secret cannot be stored. Set it and restart, or use a public client.'
    : s.clientSecretSet
      ? 'A secret is stored. Leave this blank to keep it; it is never shown again.'
      : 'The secret D3 Auth showed when you added the app. Blank for a public client.';

  return (
    <Stack as="form" gap="16" noValidate onSubmit={save} aria-label="Sign in with D3 Auth">
      {refusal === null ? null : (
        <Alert tone="danger" title={refusal.message} dynamic>
          {refusal.fix}
        </Alert>
      )}
      <FormField label="Issuer" help="The address of your D3 Auth (for example https://auth.example.com)">
        <Input
          name="issuer"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={issuer}
          onChange={(e) => {
            setIssuer(e.target.value);
          }}
        />
      </FormField>
      <FormField label="Client ID" help="The client_id in the app manifest.">
        <Input
          name="clientId"
          autoComplete="off"
          spellCheck={false}
          value={clientId}
          onChange={(e) => {
            setClientId(e.target.value);
          }}
        />
      </FormField>
      <FormField label="Client secret" help={secretHelp} optional>
        <PasswordInput
          name="clientSecret"
          autoComplete="new-password"
          disabled={!s.canStoreSecret}
          value={secret}
          onChange={(e) => {
            setSecret(e.target.value);
          }}
        />
      </FormField>
      {s.clientSecretSet ? (
        <Checkbox
          label="Remove the stored secret"
          name="clearSecret"
          checked={clearSecret}
          disabled={secret !== ''}
          onCheckedChange={(checked) => {
            setClearSecret(checked === true);
          }}
        />
      ) : null}
      {test === null ? null : <TestResult result={test} />}
      <FormActions align="start">
        <Button type="submit" variant="primary" icon={<Save />} loading={busy === 'save'} disabled={issuer.trim() === '' || clientId.trim() === ''}>
          Save
        </Button>
        <Button type="button" variant="secondary" icon={<PlugZap />} loading={busy === 'test'} disabled={issuer.trim() === ''} onClick={runTest}>
          Test
        </Button>
        {s.source === 'settings' ? (
          <Button
            type="button"
            variant="danger-ghost"
            icon={<Power />}
            onClick={() => {
              setConfirmOff(true);
            }}
          >
            Turn off
          </Button>
        ) : null}
      </FormActions>
      <Modal
        open={confirmOff}
        onOpenChange={(open) => {
          if (!open) setConfirmOff(false);
        }}
        title="Turn off Sign in with D3 Auth?"
        description="The D3 Auth button leaves the sign-in page at once and the stored issuer, client ID and secret are removed. Password and authenticator sign-in keep working."
        destructive
        footer={
          <FormActions>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setConfirmOff(false);
              }}
            >
              Keep it on
            </Button>
            <Button type="button" variant="danger" loading={busy === 'off'} onClick={turnOff}>
              Turn off
            </Button>
          </FormActions>
        }
      />
    </Stack>
  );
}

function Registration({ s }: { s: D3AuthSettings }) {
  if (s.redirectUri === null || s.manifest === null) {
    return (
      <Alert tone="warning" title="PUBLIC_URL is unset">
        Shipyard builds the redirect URI D3 Auth needs from PUBLIC_URL. Set it in server.env and restart.
      </Alert>
    );
  }
  const manifest = s.manifest;
  return (
    <Stack gap="16">
      <FormField label="Redirect URI" help="D3 Auth sends people back here after they sign in.">
        <Stack gap="8">
          <code className="shp-secret">{s.redirectUri}</code>
          <div>
            <CopyButton text={s.redirectUri} label="Copy redirect URI" />
          </div>
        </Stack>
      </FormField>
      <p>In D3 Auth&apos;s console: Apps → Add an app → upload this file; paste the client secret it shows here.</p>
      <div>
        <Button
          type="button"
          variant="secondary"
          icon={<Download />}
          onClick={() => {
            downloadManifest(manifest);
          }}
        >
          Download app manifest
        </Button>
      </div>
    </Stack>
  );
}

export function Settings() {
  const [s, setS] = useState<D3AuthSettings | null>(null);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const load = useCallback(async () => {
    try {
      setS(await settingsApi.d3auth());
      setRefusal(null);
    } catch (error) {
      setRefusal(asRefusal(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Page width="narrow">
      <Stack gap="24">
        <PageHeader title="Settings" description="Server-wide settings, for admins." />
        {refusal === null ? null : (
          <Alert tone="danger" title={refusal.message} dynamic>
            {refusal.fix}
          </Alert>
        )}
        {s === null && refusal === null ? <Spinner label="Loading settings" /> : null}
        {s === null ? null : (
          <>
            <Section
              title="Sign in with D3 Auth"
              description="Optional. Password and authenticator sign-in always works, whatever is set here."
            >
              <Stack gap="16">
                {done === 'saved' ? (
                  <Alert tone="success" title="Saved" dynamic>
                    {s.available
                      ? 'Sign in with D3 Auth is on — no restart needed.'
                      : 'The D3 Auth button stays off until the issuer answers.'}
                  </Alert>
                ) : null}
                {done === 'off' ? (
                  <Alert tone="success" title="Turned off" dynamic>
                    The sign-in page offers password and authenticator only.
                  </Alert>
                ) : null}
                <Status s={s} />
                {s.source === 'env' ? (
                  <EnvReadOnly s={s} />
                ) : (
                  // Keyed by the saved state, so a save or turn-off resets the fields to what is stored.
                  <D3AuthForm
                    key={`${s.source}:${s.updatedAt ?? ''}`}
                    s={s}
                    onDone={(next, what) => {
                      setS(next);
                      setDone(what);
                    }}
                  />
                )}
                {s.updatedAt === null ? null : <p>Last changed {shortDate(s.updatedAt)}.</p>}
              </Stack>
            </Section>
            <Section title="Register Shipyard in D3 Auth" description="What D3 Auth needs to know about this server.">
              <Registration s={s} />
            </Section>
            <AlertEmailSettings />
          </>
        )}
      </Stack>
    </Page>
  );
}
