import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import test from 'node:test';
import { tokenVerifier } from '../src/container-auth.mjs';

test('container Cognito auth verifies signatures, client, scope, issuer, expiry and access-token type offline', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'local-test-key', alg: 'RS256', use: 'sig' };
  const verify = tokenVerifier({ local: false, poolId: 'us-east-1_LocalTest', clientId: 'local-test-client' }, new Map(), { keys: [jwk] });
  const claims = { sub: randomUUID(), token_use: 'access', client_id: 'local-test-client', scope: 'openid astrashop/marketplace',
    iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_LocalTest', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 };
  function jwt(changes = {}) {
    const unsigned = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url'), Buffer.from(JSON.stringify({ ...claims, ...changes })).toString('base64url')].join('.');
    return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  }
  assert.equal((await verify('Bearer ' + jwt())).sub, claims.sub);
  for (const changes of [{ token_use: 'id' }, { client_id: 'other-client' }, { scope: 'openid' }, { exp: 1 }, { iss: 'https://outside.example' }]) {
    await assert.rejects(verify('Bearer ' + jwt(changes)));
  }
  const parts = jwt().split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...claims, sub: randomUUID() })).toString('base64url');
  await assert.rejects(verify('Bearer ' + parts.join('.')));
  await assert.rejects(verify('Bearer demo-asha'));
});
