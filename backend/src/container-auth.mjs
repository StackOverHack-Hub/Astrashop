import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { FetchError, JwksValidationError } from 'aws-jwt-verify/error';

export function tokenVerifier(config, identities, cachedJwks) {
  const verifier = config.local ? null : CognitoJwtVerifier.create({
    userPoolId: config.poolId, tokenUse: 'access', clientId: config.clientId, scope: 'astrashop/marketplace',
  });
  // Tests can supply a public key set without contacting AWS. The server never
  // reads verification keys from requests or environment settings.
  if (cachedJwks) verifier.cacheJwks(cachedJwks);
  return async (authorization) => {
    if (config.local) {
      const claims = identities.get(authorization);
      if (!claims) throw new Error('Invalid demo account');
      return claims;
    }
    if (!authorization.startsWith('Bearer ') || authorization.length > 8192) throw new Error('Invalid token');
    try { return await verifier.verify(authorization.slice(7)); }
    catch (error) {
      if (error instanceof FetchError || error instanceof JwksValidationError) {
        throw Object.assign(new Error('Sign-in service is temporarily unavailable'), { code: 'AUTH_UNAVAILABLE' });
      }
      throw error;
    }
  };
}
