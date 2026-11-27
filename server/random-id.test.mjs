import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRandomId } from '../services/randomId.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('UUID uses the native API with its original receiver', () => {
    const provider = { randomUUID() { assert.equal(this, provider); return 'native-result'; } };
    assert.equal(createRandomId(provider), 'native-result');
});

test('HTTP fallback keeps leading zeros and sets UUID version and variant bits', () => {
    const provider = { getRandomValues(bytes) { assert.equal(this, provider); return bytes.fill(0); } };
    assert.equal(createRandomId(provider), '00000000-0000-4000-8000-000000000000');
    assert.equal(createRandomId({ getRandomValues: bytes => bytes.fill(255) }), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
});

test('HTTP fallback creates unique cryptographically random UUIDs', () => {
    const provider = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) };
    const ids = Array.from({ length: 1000 }, () => createRandomId(provider));
    for (const id of ids) assert.match(id, uuidPattern);
    assert.equal(new Set(ids).size, ids.length);
});

test('missing secure randomness fails explicitly instead of using Math.random', () => {
    assert.throws(() => createRandomId({}), /安全随机数/);
    assert.throws(() => createRandomId(null), /安全随机数/);
});
