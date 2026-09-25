import type {
  D3AuthSettings,
  D3AuthSettingsUpdate,
  D3AuthTestResult,
  MailSettings,
  MailSettingsUpdate,
  MailTestResult,
} from '@shipyard/schema';
import { request } from './api';

/**
 * Settings → Sign in with D3 Auth (SHP-REQ-110, SHP-T-6.8). Admin-only on the server. The client
 * secret goes one way: it is sent on save and never comes back — only `clientSecretSet`.
 */
export const settings = {
  d3auth: (): Promise<D3AuthSettings> => request<D3AuthSettings>('/api/settings/d3auth'),
  saveD3auth: (body: D3AuthSettingsUpdate): Promise<D3AuthSettings> =>
    request<D3AuthSettings>('/api/settings/d3auth', { method: 'PUT', body }),
  clearD3auth: (): Promise<D3AuthSettings> => request<D3AuthSettings>('/api/settings/d3auth', { method: 'DELETE' }),
  testD3auth: (issuer?: string): Promise<D3AuthTestResult> =>
    request<D3AuthTestResult>('/api/settings/d3auth/test', {
      method: 'POST',
      body: issuer === undefined || issuer.trim() === '' ? {} : { issuer: issuer.trim() },
    }),
  // Alert email (SHP-T-6.9): the relay token goes one way too — only `tokenSet` comes back.
  mail: (): Promise<MailSettings> => request<MailSettings>('/api/settings/mail'),
  saveMail: (body: MailSettingsUpdate): Promise<MailSettings> => request<MailSettings>('/api/settings/mail', { method: 'PUT', body }),
  clearMail: (): Promise<MailSettings> => request<MailSettings>('/api/settings/mail', { method: 'DELETE' }),
  testMail: (): Promise<MailTestResult> => request<MailTestResult>('/api/settings/mail/test', { method: 'POST', body: {} }),
};

export const MANIFEST_FILENAME = 'shipyard.d3auth.json';

/** Saves the manifest as a file, the way D3 Auth's console wants it uploaded. */
export function downloadManifest(manifest: Record<string, unknown>): void {
  const blob = new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = MANIFEST_FILENAME;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
