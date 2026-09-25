import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepositoryIdentifier } from '../repository.js';

// yori collector (src/collector/remote.ts:68) と同じ正規化規則であることを固定する。
describe('repository identifier の正規化', () => {
  it('canonical形式をhost小文字・先頭slashなしへ揃える', () => {
    assert.equal(normalizeRepositoryIdentifier('github.com/Org/Repo'), 'github.com/Org/Repo');
    assert.equal(normalizeRepositoryIdentifier('GitHub.com/Org/Repo.git'), 'github.com/Org/Repo');
    assert.equal(normalizeRepositoryIdentifier('github.com/Org/Repo/'), 'github.com/Org/Repo');
  });

  it('HTTPS・SSH・SCP表記を同じcanonical identifierへ揃える', () => {
    assert.equal(normalizeRepositoryIdentifier('https://github.com/Org/Repo.git'), 'github.com/Org/Repo');
    assert.equal(normalizeRepositoryIdentifier('https://user:password@github.com/Org/Repo.git'), 'github.com/Org/Repo');
    assert.equal(normalizeRepositoryIdentifier('ssh://git@github.com:22/Org/Repo.git'), 'github.com/Org/Repo');
    assert.equal(normalizeRepositoryIdentifier('ssh://git@github.com/Org/Repo.git'), 'github.com/Org/Repo');
    assert.equal(normalizeRepositoryIdentifier('git@github.com:Org/Repo.git'), 'github.com/Org/Repo');
  });

  it('既定以外のportは識別子へ残す', () => {
    assert.equal(normalizeRepositoryIdentifier('https://github.com:8443/Org/Repo'), 'github.com:8443/Org/Repo');
    assert.equal(normalizeRepositoryIdentifier('ssh://git@github.com:2222/Org/Repo.git'), 'github.com:2222/Org/Repo');
    assert.equal(normalizeRepositoryIdentifier('github.com:2222/Org/Repo'), 'github.com:2222/Org/Repo');
    // scp形式の `host:2222/path` はcollectorと同じくportではなくpathの一部として解釈する
    // (yori src/collector/remote.ts:38 の正規表現)。collectorと違うidentifierを作らない。
    assert.equal(normalizeRepositoryIdentifier('git@github.com:2222/Org/Repo.git'), 'github.com/2222/Org/Repo');
  });

  it('local path・空文字・解釈できない値はnullにする', () => {
    assert.equal(normalizeRepositoryIdentifier('/local/path'), null);
    assert.equal(normalizeRepositoryIdentifier('./relative/path'), null);
    assert.equal(normalizeRepositoryIdentifier('../relative/path'), null);
    assert.equal(normalizeRepositoryIdentifier('C:\\local\\path'), null);
    assert.equal(normalizeRepositoryIdentifier('not a repository'), null);
    assert.equal(normalizeRepositoryIdentifier(''), null);
    assert.equal(normalizeRepositoryIdentifier('   '), null);
    assert.equal(normalizeRepositoryIdentifier('https://github.com/'), null);
    assert.equal(normalizeRepositoryIdentifier('ftp://github.com/Org/Repo'), null);
  });
});
