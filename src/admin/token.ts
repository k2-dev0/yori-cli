import { createHash, randomBytes } from 'node:crypto';

// 生tokenは `yori_` + 24 random bytesのbase64url。既存fixture (yori src/db/tests/fixtures.ts:61) と同じ形式。
export function generateAuthToken(): string {
  return `yori_${randomBytes(24).toString('base64url')}`;
}

// API認証 (yori src/api/events.ts:292-294) と同じくUTF-8バイト列のSHA-256を保存する。
export function hashAuthToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
