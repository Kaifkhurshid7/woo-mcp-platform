import crypto from 'node:crypto';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const uuid = () => crypto.randomUUID();

// ---- passwords: scrypt with per-password salt -------------------------------------------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

// ---- API keys ----------------------------------------------------------------------------
// Keys are 256 bits of randomness, so a plain SHA-256 is sufficient for storage (there is nothing
// to brute-force, unlike human passwords) and keeps per-request verification cheap.
export function generateApiKey() {
  const secret = randomToken(32);
  const key = `gw_${secret}`;
  return { key, hash: sha256(key), prefix: key.slice(0, 11) };
}

// ---- encryption at rest for upstream credentials (AES-256-GCM) ---------------------------
export function createVault(secret) {
  if (!secret || secret.length < 16) {
    throw new Error('ENCRYPTION_KEY must be set (at least 16 characters; use a long random value)');
  }
  const key = crypto.createHash('sha256').update(`mcp-gateway-vault:${secret}`).digest();
  return {
    encrypt(plaintext) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
    },
    decrypt(blob) {
      const [v, iv, tag, ct] = blob.split(':');
      if (v !== 'v1') throw new Error('Unsupported credential format');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}
