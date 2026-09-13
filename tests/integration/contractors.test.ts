import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { migrate } from '../../src/db.js';
import { Store } from '../../src/store.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a dedicated PostgreSQL test database');
const schema = `signup_test_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, ADMIN_API_KEY: 'test-admin-key-that-is-at-least-32',
  OPENAI_API_KEY: 'unused', LINQ_FROM_NUMBER: '+16504447573' });
const app = createApp(config, new Store(pool));
const payload = (extra = {}) => ({ submissionId: randomUUID(), firstName: ' Alex ', lastName: ' Rivera ',
  phone: '(415) 555-0123', email: 'Alex@Example.com', website: '', licenseNumber: '', ...extra });

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

test('signup stores all fields in this project database without queuing messages', async () => {
  const input = payload({ website: 'example.com', licenseNumber: ' CA-1234 ' });
  const response = await request(app).post('/api/contractors/signup').send(input).expect(201);
  assert.equal(response.body.agent.phone, '+16504447573');
  const saved = (await pool.query('SELECT * FROM contractor_signups WHERE id=$1', [input.submissionId])).rows[0];
  assert.equal(saved.first_name, 'Alex'); assert.equal(saved.last_name, 'Rivera');
  assert.equal(saved.email, 'alex@example.com'); assert.equal(saved.phone, '+14155550123');
  assert.equal(saved.website, 'https://example.com'); assert.equal(saved.license_number, 'CA-1234');
  assert.equal(saved.agent_phone, '+16504447573');
  assert.equal((await pool.query('SELECT count(*) FROM turns')).rows[0].count, '0');
  assert.equal((await pool.query('SELECT count(*) FROM conversations')).rows[0].count, '0');
});

test('concurrent retries preserve one original signup and its assigned agent', async () => {
  const input = payload();
  await Promise.all(Array.from({ length: 5 }, () => request(app).post('/api/contractors/signup').send(input).expect(201)));
  const otherApp = createApp({ ...config, LINQ_FROM_NUMBER: '+14155550101' }, new Store(pool));
  const retry = await request(otherApp).post('/api/contractors/signup').send({ ...input, firstName: 'Changed' }).expect(201);
  assert.equal(retry.body.agent.phone, '+16504447573');
  const saved = (await pool.query('SELECT * FROM contractor_signups WHERE id=$1', [input.submissionId])).rows;
  assert.equal(saved.length, 1); assert.equal(saved[0].first_name, 'Alex');
  assert.equal(saved[0].website, null); assert.equal(saved[0].license_number, null);
});

test('invalid submissions and missing agent configuration never save a signup', async () => {
  const input = payload();
  await request(app).post('/api/contractors/signup').send({ ...input, phone: 'bad' }).expect(400);
  const unavailable = createApp({ ...config, LINQ_FROM_NUMBER: '' }, new Store(pool));
  await request(unavailable).post('/api/contractors/signup').send(input).expect(503);
  assert.equal((await pool.query('SELECT count(*) FROM contractor_signups WHERE id=$1', [input.submissionId])).rows[0].count, '0');
});
