// Deterministic, correctly checksummed test addresses (TRON base58check, EVM EIP-55) for the wallet E2E tests.
// The EIP-55 checksum comes from Wallet Logger's own wallet-core (its keccak is verified by its unit tests).
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {repoRoot} from './portable.mjs';

export const core = createRequire(import.meta.url)(join(repoRoot, 'integrations', 'crypto-wallet-logger-v08', 'wallet-core.js'));
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b) break; s = '1' + s; } return s; }
async function sha(b) { return new Uint8Array(await crypto.subtle.digest('SHA-256', b)); }
export async function tron(seed) { const body = new Uint8Array(21); body[0] = 0x41; for (let i = 1; i < 21; i++) body[i] = (seed * 31 + i * 17) & 255; const c = (await sha(await sha(body))).slice(0, 4); return b58(new Uint8Array([...body, ...c])); }
export const evm = seed => core.eip55Checksum('0x' + Array.from({length: 20}, (_, i) => ((seed * 13 + i * 7) & 255).toString(16).padStart(2, '0')).join(''));
export const brokenEvm = a => a.slice(0, 2) + [...a.slice(2)].map((ch, i) => i === 3 && /[a-f]/i.test(ch) ? (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()) : ch).join('');
