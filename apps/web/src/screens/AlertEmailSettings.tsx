import {
  Alert,
  Badge,
  Button,
  DescriptionItem,
  DescriptionList,
  FormActions,
  FormField,
  Input,
  Modal,
  PasswordInput,
  Section,
  Spinner,
  Stack,
} from '@d3cloud/ui';
import type { MailSettings, MailTestResult } from '@shipyard/schema';
import { Power, Save, Send } from 'lucide-react';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { shortDate } from '../lib/admin';
import { RefusalError, unreachableRefusal } from '../lib/api';
import { settings as settingsApi } from '../lib/settings';

/**
 * Settings → Alert email (SHP-T-6.9, SHP-REQ-093): the mail relay the stale-agent and failed
 * backup/drill alerts go through, and who receives them. Admin-only like the rest of Settings. The
 * relay token is write-only: the screen only ever learns whether one is stored. MAIL_RELAY_URL /
 * MAIL_RELAY_TOKEN / ALERT_TO in server.env win, and then this section is read-only.
 *
 * Button and status names say "alert email" to an assistive technology, so they are told apart
 * from the D3 Auth section's Save and Turn off on the same screen.
 */

function asRefusal(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

function Status({ m }: { m: MailSettings }) {
  if (m.source === 'none') {
    return (
      <p>
        <Badge tone="neutral">Alerts off</Badge> Alerts are written to the server log only.
      </p>
    );
  }
  if (m.active) {
    return (
      <p>
        <Badge tone="neutral">Alerts on</Badge> Alerts are emailed to {m.alertTo ?? 'the recipient'}.
      </p>
    );
  }
  return (
    <Alert tone="warning" title="Configured, but alert email cannot send">
      {m.problem ?? 'Alert email is not available right now.'}
    </Alert>
  );
}

function TestResult({ result, to }: { result: MailTestResult; to: string | null }) {
  const status = result.status === undefined ? null : `HTTP ${String(result.status)}`;
  if (result.sent) {
    return (
      <Alert tone="success" title="The relay accepted the test message" dynamic>
        {status}
        {to === null ? '.' : ` — check ${to}.`}
      </Alert>
    );
  }
  return (
    <Alert tone="danger" title="The relay did not send it" dynamic>
      {[status, result.detail].filter((part): part is string => typeof part === 'string' && part !== '').join(': ') ||
        'No answer from the relay.'}
    </Alert>
  );
}

function EnvReadOnly({ m }: { m: MailSettings }) {
  return (
    <Stack gap="16">
      <Alert tone="info" title="Set in server.env">
        MAIL_RELAY_URL, MAIL_RELAY_TOKEN and ALERT_TO in server.env win over this screen. To change them, edit server.env
        and restart; to manage alert email here instead, remove all three there.
      </Alert>
      <DescriptionList>
        <DescriptionItem term="Relay URL">{m.relayUrl ?? 'Not set'}</DescriptionItem>
        <DescriptionItem term="Relay token">{m.tokenSet ? 'Set' : 'Not set'}</DescriptionItem>
        <DescriptionItem term="Recipient">{m.alertTo ?? 'Not set'}</DescriptionItem>
      </DescriptionList>
    </Stack>
  );
}

type Done = 'saved' | 'off';

function MailForm({ m, onDone }: { m: MailSettings; onDone: (next: MailSettings, what: Done) => void }) {
  const [relayUrl, setRelayUrl] = useState(m.relayUrl ?? '');
  const [token, setToken] = useState('');
  const [alertTo, setAlertTo] = useState(m.alertTo ?? '');
  const [busy, setBusy] = useState<'save' | 'off' | null>(null);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  const save = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy !== null) return;
    setBusy('save');
    setRefusal(null);
    settingsApi
      .saveMail({ relayUrl: relayUrl.trim(), alertTo: alertTo.trim(), ...(token !== '' ? { token } : {}) })
      .then((next) => {
        setToken('');
        onDone(next, 'saved');
      })
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
      .clearMail()
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

  const tokenHelp = !m.canStoreSecret
    ? 'SESSION_SECRET is unset in server.env, so a token cannot be stored. Set it and restart.'
    : m.tokenSet
      ? 'A token is stored. Leave this blank to keep it; it is never shown again.'
      : "The relay's secret — on the D3 host, from D3 Auth's mail-relay Worker settings.";

  const incomplete = relayUrl.trim() === '' || alertTo.trim() === '' || (!m.tokenSet && token === '');

  return (
    <Stack as="form" gap="16" noValidate onSubmit={save} aria-label="Alert email">
      {refusal === null ? null : (
        <Alert tone="danger" title={refusal.message} dynamic>
          {refusal.fix}
        </Alert>
      )}
      <FormField label="Relay URL" help="Where alerts are posted: https, or http only for localhost.">
        <Input
          name="relayUrl"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={relayUrl}
          onChange={(e) => {
            setRelayUrl(e.target.value);
          }}
        />
      </FormField>
      <FormField label="Relay token" help={tokenHelp}>
        <PasswordInput
          name="relayToken"
          autoComplete="new-password"
          disabled={!m.canStoreSecret}
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
          }}
        />
      </FormField>
      <FormField label="Recipient" help="The address alerts are sent to.">
        <Input
          name="alertTo"
          type="email"
          inputMode="email"
          autoComplete="email"
          spellCheck={false}
          value={alertTo}
          onChange={(e) => {
            setAlertTo(e.target.value);
          }}
        />
      </FormField>
      <FormActions align="start">
        <Button type="submit" variant="primary" icon={<Save />} loading={busy === 'save'} disabled={incomplete} aria-label="Save alert email">
          Save
        </Button>
        {m.source === 'settings' ? (
          <Button
            type="button"
            variant="danger-ghost"
            icon={<Power />}
            aria-label="Turn off alert email"
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
        title="Turn off alert email?"
        description="The stored relay URL, token and recipient are removed. Alerts are written to the server log only until it is set up again."
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

function SendTest({ m }: { m: MailSettings }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MailTestResult | null>(null);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);

  const send = () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    setRefusal(null);
    settingsApi
      .testMail()
      .then(setResult)
      .catch((error: unknown) => {
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Stack gap="16">
      {result === null ? null : <TestResult result={result} to={m.alertTo} />}
      {refusal === null ? null : (
        <Alert tone="danger" title={refusal.message} dynamic>
          {refusal.fix}
        </Alert>
      )}
      <div>
        <Button type="button" variant="secondary" icon={<Send />} loading={busy} disabled={!m.active} onClick={send}>
          Send test email
        </Button>
      </div>
    </Stack>
  );
}

export function AlertEmailSettings() {
  const [m, setM] = useState<MailSettings | null>(null);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const load = useCallback(async () => {
    try {
      setM(await settingsApi.mail());
      setRefusal(null);
    } catch (error) {
      setRefusal(asRefusal(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Section
      title="Alert email"
      description="Optional. Shipyard emails when the agent has been silent for more than five minutes, or a nightly backup or restore drill fails. On the D3 host the relay is D3 Auth's mail-relay Worker: its URL and secret are in that Worker's settings."
    >
      <Stack gap="16">
        {refusal === null ? null : (
          <Alert tone="danger" title={refusal.message} dynamic>
            {refusal.fix}
          </Alert>
        )}
        {m === null && refusal === null ? <Spinner label="Loading alert email" /> : null}
        {m === null ? null : (
          <>
            {done === 'saved' ? (
              <Alert tone="success" title="Alert email saved" dynamic>
                {m.active ? 'The next alert uses it — no restart needed.' : 'Saved, but it cannot send yet; see below.'}
              </Alert>
            ) : null}
            {done === 'off' ? (
              <Alert tone="success" title="Alert email turned off" dynamic>
                Alerts are written to the server log only.
              </Alert>
            ) : null}
            <Status m={m} />
            {m.source === 'env' ? (
              <EnvReadOnly m={m} />
            ) : (
              // Keyed by the saved state, so a save or turn-off resets the fields to what is stored.
              <MailForm
                key={`${m.source}:${m.updatedAt ?? ''}`}
                m={m}
                onDone={(next, what) => {
                  setM(next);
                  setDone(what);
                }}
              />
            )}
            <SendTest key={`test:${m.source}:${m.updatedAt ?? ''}`} m={m} />
            {m.updatedAt === null ? null : <p>Alert email last changed {shortDate(m.updatedAt)}.</p>}
          </>
        )}
      </Stack>
    </Section>
  );
}
