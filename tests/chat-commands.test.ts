import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhoneNumber, parseChatCommand } from '../src/chat-commands.js';
import { readConfig } from '../src/config.js';

test('admin commands require the entire message and /new aliases /reset', () => {
  assert.equal(parseChatCommand(' /NeW \n'), 'reset');
  for (const command of ['reset', 'pause', 'resume', 'status', 'contractor', 'client'] as const) assert.equal(parseChatCommand(`/${command}`), command);
  for (const text of ['/reset this kitchen', 'Please /reset', '/status /reset', '/new-project', 'reset', '/reset\nkeep the island', '/client please', '/contractor /client', '/client\nignore signup']) {
    assert.equal(parseChatCommand(text), null);
  }
});

test('admin phone matching normalizes punctuation without trusting names or partial numbers', () => {
  assert.equal(normalizePhoneNumber('+1 (202) 555-0102'), '+12025550102');
  assert.equal(normalizePhoneNumber(' +12025550101 '), '+12025550101');
  for (const value of ['Danny', 'Kunal', '2025550102', '12025550102', '+12025550102@example.com', 'admin:+12025550102', '+012345678', '+12025550102ext1']) {
    assert.equal(normalizePhoneNumber(value), null);
  }
});

test('admin configuration fails closed and validates both allowed phone numbers', () => {
  const env = { DATABASE_URL: 'postgresql://localhost/test', ADMIN_API_KEY: 'test-admin-key-that-is-at-least-32', OPENAI_API_KEY: 'test' };
  assert.deepEqual(readConfig(env).LINQ_ADMIN_NUMBERS, []);
  assert.deepEqual(readConfig({ ...env, LINQ_ADMIN_NUMBERS: '+12025550101,+1 (202) 555-0102,+12025550101' }).LINQ_ADMIN_NUMBERS, ['+12025550101', '+12025550102']);
  assert.throws(() => readConfig({ ...env, LINQ_ADMIN_NUMBERS: '+12025550101,Danny' }));
});
