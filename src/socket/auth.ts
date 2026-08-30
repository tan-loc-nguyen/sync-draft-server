import { createRemoteJWKSet, jwtVerify } from 'jose';

import '../config/env.js';

// Resolves a bearer token to the Auth0 subject it belongs to, or throws.
export type TokenVerifier = (token: string) => Promise<string>;

const normaliseIssuer = (domain: string) => (domain.endsWith('/') ? domain : `${domain}/`);

// The REST API is guarded by express-oauth2-jwt-bearer, but Socket.IO never
// passes through Express middleware, so the handshake needs its own check
// against the same Auth0 tenant.
export const createAuth0TokenVerifier = (): TokenVerifier => {
  // Built on first use so the server can start (and tests can run) without
  // reaching out to Auth0.
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  return async (token: string): Promise<string> => {
    const domain = process.env.AUTH0_DOMAIN || '';
    const audience = process.env.AUTH0_AUDIENCE || '';

    if (!domain || !audience) {
      throw new Error('AUTH0_DOMAIN and AUTH0_AUDIENCE must be configured');
    }

    const issuer = normaliseIssuer(domain);

    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));
    }

    const { payload } = await jwtVerify(token, jwks, { issuer, audience });

    if (!payload.sub) {
      throw new Error('Token carries no subject');
    }

    return payload.sub;
  };
};
