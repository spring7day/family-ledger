// 사용법: LEDGER_PW='...' LEDGER_TOKEN='github_pat_...' node tools/make-config.mjs > config.js
// 토큰 없이 실행하면 기기 로컬 저장 모드 config 생성
import { webcrypto as crypto, randomBytes } from 'node:crypto';

const pw = process.env.LEDGER_PW;
const token = process.env.LEDGER_TOKEN || '';
const repo = process.env.LEDGER_REPO || 'spring7day/family-ledger-data';
if (!pw) { console.error('LEDGER_PW 필요'); process.exit(1); }

const b64 = (u8) => Buffer.from(u8).toString('base64');
const enc = new TextEncoder();
const pwSalt = b64(randomBytes(16));
const hash = Buffer.from(await crypto.subtle.digest('SHA-256', enc.encode(pwSalt + pw))).toString('hex');

let tokenBlob = null;
if (token) {
  const salt = randomBytes(16), iv = randomBytes(12), iter = 600000;
  const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(token)));
  tokenBlob = { salt: b64(salt), iv: b64(iv), iter, ct: b64(ct) };
}
const cfg = token ? { repo, branch: 'main', tokenBlob } : { repo, branch: 'main', pwSalt, pwHash: hash, tokenBlob: null };
process.stdout.write(`window.LEDGER_CONFIG = ${JSON.stringify(cfg, null, 1)};\n`);
