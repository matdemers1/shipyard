// The D3 relay envelope, version 1 (SHP-T-11.4; d3-app-contract spec/push.md, CON-ADR-016). Every
// notification is sealed to a key the device made for this connection, with a fresh ephemeral key
// each time, so neither the relay nor Apple can read it:
//
//   shared   = ECDH(ephemeral private, device public)
//   key      = HKDF-SHA256(shared, salt = ephemeral.pub ‖ device.pub, info = "d3-relay-envelope-v1")
//   sealed   = AES-256-GCM(key, 12-byte nonce, plaintext, aad = "d3-relay-envelope-v1")
//   envelope = base64(0x01 ‖ ephemeral.pub (65) ‖ nonce (12) ‖ ciphertext ‖ tag (16))
import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes, type ECDH } from 'node:crypto';

const INFO = 'd3-relay-envelope-v1';
const VERSION = 1;
const POINT = 65;

function keyFor(shared: Buffer, ephemeralPub: Buffer, devicePub: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeralPub, devicePub]), INFO, 32));
}

/** A P-256 public key in X9.63 uncompressed form: 65 bytes, leading 0x04. */
export function isDevicePublicKey(raw: Uint8Array): boolean {
  if (raw.length !== POINT || raw[0] !== 0x04) return false;
  try {
    // Off-curve points are refused by the key agreement itself; this is where it is found out.
    const probe = createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(Buffer.from(raw));
    return true;
  } catch {
    return false;
  }
}

export function sealEnvelope(devicePublicKey: Uint8Array, plaintext: Uint8Array): string {
  const device = Buffer.from(devicePublicKey);
  const ephemeral = createECDH('prime256v1');
  ephemeral.generateKeys();
  const ephemeralPub = ephemeral.getPublicKey();
  const key = keyFor(ephemeral.computeSecret(device), ephemeralPub, device);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(INFO));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), ephemeralPub, nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
}

/** The other half, for tests and for opening the contract's reference vectors. */
export function openEnvelope(device: ECDH, envelope: string): Buffer {
  const raw = Buffer.from(envelope, 'base64');
  if (raw[0] !== VERSION || raw.length < 1 + POINT + 12 + 16) throw new Error('not a version 1 envelope');
  const ephemeralPub = raw.subarray(1, 1 + POINT);
  const nonce = raw.subarray(1 + POINT, 1 + POINT + 12);
  const body = raw.subarray(1 + POINT + 12, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);
  const key = keyFor(device.computeSecret(ephemeralPub), ephemeralPub, device.getPublicKey());
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(INFO));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
