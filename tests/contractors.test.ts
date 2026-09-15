import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import * as v from 'valibot';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { contractorSignupSchema } from '../src/contractor-schema.js';
import { contractorSignupSchema as clientSchema } from '../web/src/schema/contractor.js';
import { createFormVCard } from '../web/src/lib/contractorContact.js';

const valid = { firstName: 'Alex', lastName: 'Rivera', phone: '(415) 555-0123', email: 'Alex@Example.com', website: '', licenseNumber: '' };
const payload = (extra = {}) => ({ ...valid, submissionId: randomUUID(), ...extra });
const config = readConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/agent_test',
  ADMIN_API_KEY: 'test-admin-key-that-is-at-least-32', OPENAI_API_KEY: 'unused', LINQ_FROM_NUMBER: '+16504447573' });

test('signup requires personal details, permits blank business fields, and normalizes values', () => {
  assert(v.safeParse(clientSchema, valid).success);
  assert(contractorSignupSchema.safeParse(payload()).success);
  for (const field of ['firstName', 'lastName', 'phone', 'email']) {
    assert.equal(v.safeParse(clientSchema, { ...valid, [field]: ' ' }).success, false);
    assert.equal(contractorSignupSchema.safeParse(payload({ [field]: ' ' })).success, false);
  }
  const saved = contractorSignupSchema.parse(payload({ firstName: ' Alex ', website: 'example.com', licenseNumber: ' CA-1234 ' }));
  assert.equal(saved.firstName, 'Alex');
  assert.equal(saved.email, 'alex@example.com');
  assert.equal(saved.phone, '+14155550123');
  assert.equal(saved.website, 'https://example.com');
  assert.equal(saved.licenseNumber, 'CA-1234');
});

test('client and server reject invalid phones and unsafe website URLs', () => {
  for (const phone of ['+44 20 7946 0958', '+61 (2) 5550-1234', '+1 415 555 0123']) {
    assert(contractorSignupSchema.safeParse(payload({ phone })).success);
    assert(v.safeParse(clientSchema, { ...valid, phone }).success);
  }
  for (const phone of ['abc4155550123', '123', '442079460958', '+0123456789']) {
    assert.equal(contractorSignupSchema.safeParse(payload({ phone })).success, false);
    assert.equal(v.safeParse(clientSchema, { ...valid, phone }).success, false);
  }
  for (const website of ['javascript:alert(1)', 'ftp://example.com', 'not a website', 'https://', 'https://user:password@example.com', 'https://example.com/with space']) {
    assert.equal(contractorSignupSchema.safeParse(payload({ website })).success, false, website);
    assert.equal(v.safeParse(clientSchema, { ...valid, website }).success, false, website);
  }
});

test('public signup does not require or expose the admin key and rejects missing configuration', async () => {
  let calls = 0;
  const store = { async registerContractor() { calls++; return { agent_phone: config.LINQ_FROM_NUMBER }; } } as unknown as Store;
  const app = createApp(config, store);
  const response = await request(app).post('/api/contractors/signup').send(payload()).expect(201);
  assert.equal(response.body.agent.phone, '+16504447573');
  assert(!JSON.stringify(response.body).includes(config.ADMIN_API_KEY));
  assert.equal(response.headers['cache-control'], 'no-store');
  await request(app).get('/api/conversations').expect(401);
  await request(app).post('/api/contractors/signup').send(payload({ email: 'bad' })).expect(400);
  await request(app).post('/api/contractors/signup').send({ ...payload(), message: 'not a message endpoint' }).expect(400);
  await request(createApp({ ...config, LINQ_FROM_NUMBER: '' }, store)).post('/api/contractors/signup').send(payload()).expect(503);
  assert.equal(calls, 1);
});

test('signup rate limits one client without blocking a different Render-forwarded client', async () => {
  const store = { async registerContractor() { return { agent_phone: config.LINQ_FROM_NUMBER }; } } as unknown as Store;
  const app = createApp(config, store);
  for (let i = 0; i < 20; i++) await request(app).post('/api/contractors/signup').set('X-Forwarded-For', '192.0.2.1').send(payload()).expect(201);
  await request(app).post('/api/contractors/signup').set('X-Forwarded-For', '192.0.2.1').send(payload()).expect(429);
  await request(app).post('/api/contractors/signup').set('X-Forwarded-For', '192.0.2.2').send(payload()).expect(201);
});

test('landing, signup and sandbox are served with their assets and expected security policy', async () => {
  const app = createApp(config, {} as Store);
  for (const url of ['/', '/contractors', '/signup']) {
    const response = await request(app).get(url).expect(200);
    assert.match(response.text, /FORM for Contractors/);
    assert.match(response.text, /\/site\/assets\//);
    assert(!response.text.includes('/app.js'));
    assert.match(response.headers['content-security-policy'] ?? '', /https:\/\/images.ctfassets.net/);
    const assets = [...response.text.matchAll(/(?:src|href)="(\/site\/assets\/[^\"]+)"/g)].map((match) => match[1]!);
    for (const asset of assets) await request(app).get(asset).expect(200);
  }
  assert.match((await request(app).get('/sandbox').expect(200)).text, /FORM sandbox/);
  await request(app).get('/fonts/GT-America-Standard-Regular.woff2').expect(200);
  await request(app).get('/kitchen-sample.jpg').expect(200);
});

test('FORM contact card contains the exact assigned phone and safe vCard line folding', () => {
  const card = createFormVCard({ name: 'FORM; Design, Team\n' + 'é'.repeat(70), phone: '+16504447573', email: null, website: null });
  assert.match(card, /BEGIN:VCARD\r\nVERSION:3.0\r\n/);
  assert(card.includes('TEL;TYPE=CELL,WORK:+16504447573\r\n'));
  assert(card.includes('FORM\\; Design\\, Team\\n'));
  for (const line of card.split('\r\n')) assert(Buffer.byteLength(line, 'utf8') <= 75);
  assert(card.endsWith('END:VCARD\r\n'));
});
