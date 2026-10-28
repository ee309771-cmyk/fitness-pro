import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('upstream license and attribution are preserved', async () => {
  const notice = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.match(notice, /e4948c2f78e897f0adf7c2cae296d08c8975939b/);
  const license = await readFile(new URL('../src/vendor/workoutvision/LICENSE', import.meta.url), 'utf8');
  assert.match(license, /David Dabert/);
});
