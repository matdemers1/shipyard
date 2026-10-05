import { Router } from 'express';
import type { Config } from '../config.js';
import { oidcSourceOf, publicOrigin, type AuthDeps } from '../auth/index.js';

// The D3 App contract's manifest (SHP-T-10.1, CON-ADR-003), unauthenticated, at the origin's root.
// D3 Constellation trusts nothing about this server before it has read this.

export const CAPABILITIES = ['shipyard.stacks', 'shipyard.deploy', 'shipyard.approve', 'shipyard.rollback'] as const;

export function wellKnownRouter(deps: { config: Config; oidc: AuthDeps['oidc'] }): Router {
  const router = Router();
  const oidcSource = oidcSourceOf(deps.oidc);
  router.get('/.well-known/d3-app.json', (req, res) => {
    const base = publicOrigin(deps.config, req);
    // D3 Auth is offered only while it is configured (the console's Settings can change that at
    // any time); its tokens name this origin as their resource.
    const issuer = oidcSource.current()?.issuer ?? null;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      product: 'shipyard',
      name: 'Shipyard',
      version: deps.config.SHIPYARD_VERSION,
      revision: process.env['SHIPYARD_REVISION'] ?? null,
      contract: 1,
      capabilities: [...CAPABILITIES],
      signIn: {
        methods: issuer === null ? ['password', 'totp'] : ['password', 'totp', 'd3auth'],
        ...(issuer === null ? {} : { d3auth: { issuer, resource: base } }),
      },
      endpoints: {
        nativeSignIn: `${base}/api/auth/native/signin`,
        nativeRefresh: `${base}/api/auth/native/refresh`,
        nativeRevoke: `${base}/api/auth/native/revoke`,
        me: `${base}/api/auth/me`,
        link: issuer === null ? null : `${base}/api/auth/native/link`,
        inviteAccept: null,
        deleteAccount: null,
        relayRegister: `${base}/api/push/native/register`,
        stepUp: `${base}/api/auth/step-up`,
      },
    });
  });
  return router;
}
