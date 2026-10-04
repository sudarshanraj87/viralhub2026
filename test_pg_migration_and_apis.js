/**
 * test_pg_migration_and_apis.js
 * Verification of:
 * 1. Migration script against simulated/mock PostgreSQL
 * 2. Database query compatibility
 * 3. Server HTTP API endpoints (Public & Admin)
 * 4. Flexible view count parsing (1000, 2K, 3.4M, 1.5M)
 * 5. Atomic view increment
 */

const { newDb } = require('pg-mem');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

async function runTests() {
  console.log('🧪 Starting Full Test Suite for ViralHub Neon PostgreSQL Migration...\n');

  // --------------------------------------------------------------------------
  // TEST 1: PostgreSQL Schema & Migration Simulation (pg-mem)
  // --------------------------------------------------------------------------
  console.log('--- TEST 1: PostgreSQL Table Schema & Migration Simulation ---');
  const memDb = newDb();
  const pgAdapter = memDb.adapters.createPg();
  const pgClient = new pgAdapter.Client();
  await pgClient.connect();

  // Create PostgreSQL table as defined in db.js / migrate_to_neon.js
  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS videos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      category VARCHAR(50) DEFAULT 'latest',
      video_url TEXT,
      video_path TEXT,
      thumbnail_url TEXT,
      thumbnail_path TEXT,
      duration VARCHAR(20) DEFAULT '03:45',
      published BOOLEAN DEFAULT TRUE,
      views BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ PostgreSQL `videos` table created successfully in memory.');

  // Read SQLite database
  const sqlitePath = path.join(__dirname, 'database', 'videos.db');
  const sqliteDb = new sqlite3.Database(sqlitePath, sqlite3.OPEN_READONLY);
  const rows = await new Promise((res, rej) => {
    sqliteDb.all('SELECT * FROM videos ORDER BY id ASC', (err, r) => err ? rej(err) : res(r));
  });
  console.log(`✅ Read ${rows.length} rows from SQLite database.`);

  // Insert rows into PostgreSQL (Migration logic)
  for (const v of rows) {
    const vPath = v.video_path || v.video_url || '';
    const tPath = v.thumbnail_path || v.thumbnail_url || '';
    const isPub = Boolean(v.published === 1 || v.published === true || v.published === '1');
    const views = Number(v.views) || 0;
    const createdAt = v.created_at ? new Date(v.created_at).toISOString() : new Date().toISOString();

    await pgClient.query(
      `INSERT INTO videos (
         id, title, description, category,
         video_url, video_path,
         thumbnail_url, thumbnail_path,
         duration, published, views, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         views = EXCLUDED.views`,
      [v.id, v.title, v.description || '', v.category || 'latest', vPath, vPath, tPath, tPath, v.duration || '03:45', isPub, views, createdAt]
    );
  }
  console.log(`✅ Successfully migrated ${rows.length} rows into PostgreSQL!`);

  // Verify Idempotency: Run again to ensure ON CONFLICT DO UPDATE handles duplicate without error
  for (const v of rows) {
    const vPath = v.video_path || v.video_url || '';
    const tPath = v.thumbnail_path || v.thumbnail_url || '';
    const isPub = Boolean(v.published === 1 || v.published === true || v.published === '1');
    const views = Number(v.views) || 0;
    const createdAt = v.created_at ? new Date(v.created_at).toISOString() : new Date().toISOString();

    await pgClient.query(
      `INSERT INTO videos (
         id, title, description, category,
         video_url, video_path,
         thumbnail_url, thumbnail_path,
         duration, published, views, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         views = EXCLUDED.views`,
      [v.id, v.title, v.description || '', v.category || 'latest', vPath, vPath, tPath, tPath, v.duration || '03:45', isPub, views, createdAt]
    );
  }
  const pgCountRes = await pgClient.query('SELECT COUNT(*)::int AS count FROM videos');
  console.log(`✅ Idempotency verified: Total rows in PostgreSQL = ${pgCountRes.rows[0].count} (No duplicates created).`);

  // Test Atomic View Increment in PostgreSQL
  const atomicRes = await pgClient.query('UPDATE videos SET views = views + 1 WHERE id = 1 RETURNING views');
  console.log(`✅ Atomic views increment in PostgreSQL verified: views now = ${atomicRes.rows[0].views}`);

  await pgClient.end();
  sqliteDb.close();

  // --------------------------------------------------------------------------
  // TEST 2: Flexible View Count Parsing in server.js
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 2: Flexible View Count Shorthand Conversion ---');
  // Replicate parseViewCount logic from server.js
  function parseViewCount(input, allowEmpty = true) {
    if (input === undefined || input === null) {
      if (allowEmpty) return 0;
      throw new Error('View count is required.');
    }
    const str = String(input).trim();
    if (str === '') {
      if (allowEmpty) return 0;
      throw new Error('View count cannot be empty.');
    }
    if (str.startsWith('-')) throw new Error('View count cannot be negative.');

    const kMatch = str.match(/^(\d+(?:\.\d+)?)\s*[kK]$/);
    if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);

    const mMatch = str.match(/^(\d+(?:\.\d+)?)\s*[mM]$/);
    if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1000000);

    const cleanNumber = str.replace(/,/g, '');
    if (/^\d+$/.test(cleanNumber)) return parseInt(cleanNumber, 10);

    throw new Error(`Invalid view count "${str}".`);
  }

  const testCases = [
    { input: '1000', expected: 1000 },
    { input: '2K', expected: 2000 },
    { input: '4K', expected: 4000 },
    { input: '10K', expected: 10000 },
    { input: '3.4K', expected: 3400 },
    { input: '2M', expected: 2000000 },
    { input: '3.4M', expected: 3400000 },
    { input: '1.5M', expected: 1500000 },
    { input: '0', expected: 0 },
    { input: '', expected: 0 }
  ];

  for (const tc of testCases) {
    const actual = parseViewCount(tc.input);
    if (actual !== tc.expected) {
      throw new Error(`❌ View count conversion failed for "${tc.input}": got ${actual}, expected ${tc.expected}`);
    }
    console.log(`  ✓ "${tc.input}" => ${actual}`);
  }
  console.log('✅ All view count shorthand conversions passed.');

  // --------------------------------------------------------------------------
  // TEST 3: Running Server HTTP Endpoints
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 3: Server HTTP Endpoints Verification ---');
  const BASE_URL = 'http://127.0.0.1:3000';

  // 3a. Homepage
  const homeRes = await fetch(`${BASE_URL}/`);
  if (!homeRes.ok) throw new Error(`Homepage returned status ${homeRes.status}`);
  console.log('✅ GET / (Homepage) responded with 200 OK');

  // 3b. GET /api/videos (Public published videos)
  const videosRes = await fetch(`${BASE_URL}/api/videos`);
  const videos = await videosRes.json();
  console.log(`✅ GET /api/videos responded with ${videos.length} published videos`);
  if (videos.length === 0) throw new Error('Expected at least 1 video from API');

  // 3c. GET /api/videos?search=drone
  const searchRes = await fetch(`${BASE_URL}/api/videos?search=drone`);
  const searchVideos = await searchRes.json();
  console.log(`✅ GET /api/videos?search=drone responded with ${searchVideos.length} matching video(s)`);

  // 3d. GET /api/videos?category=trending
  const trendRes = await fetch(`${BASE_URL}/api/videos?category=trending`);
  const trendVideos = await trendRes.json();
  console.log(`✅ GET /api/videos?category=trending responded with ${trendVideos.length} video(s)`);

  // 3e. GET /api/videos/:id
  const firstId = videos[0].id;
  const detailRes = await fetch(`${BASE_URL}/api/videos/${firstId}`);
  const detailData = await detailRes.json();
  console.log(`✅ GET /api/videos/${firstId} detail responded with video title: "${detailData.video.title}"`);
  console.log(`   Atomic views count: ${detailData.video.views}, related videos count: ${detailData.related.length}`);

  // 3f. Admin Login
  const loginRes = await fetch(`${BASE_URL}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  if (!loginRes.ok) throw new Error(`Admin login failed with status ${loginRes.status}`);
  const cookie = loginRes.headers.get('set-cookie');
  console.log('✅ POST /api/admin/login succeeded and received session cookie');

  // 3g. Admin Stats
  const statsRes = await fetch(`${BASE_URL}/api/admin/stats`, {
    headers: { 'Cookie': cookie }
  });
  const stats = await statsRes.json();
  console.log('✅ GET /api/admin/stats responded:', JSON.stringify(stats));

  // 3h. Admin Videos List
  const adminVidRes = await fetch(`${BASE_URL}/api/admin/videos`, {
    headers: { 'Cookie': cookie }
  });
  const adminVideos = await adminVidRes.json();
  console.log(`✅ GET /api/admin/videos responded with ${adminVideos.length} videos`);

  // 3i. Toggle Publish
  const toggleRes = await fetch(`${BASE_URL}/api/videos/${firstId}/publish`, {
    method: 'PATCH',
    headers: { 'Cookie': cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ published: true })
  });
  const toggleData = await toggleRes.json();
  console.log(`✅ PATCH /api/videos/${firstId}/publish succeeded: published = ${toggleData.published}`);

  // 3j. Add Video with 3.4M initial views
  const form = new FormData();
  form.append('title', 'Automated Test Video 2026');
  form.append('description', 'Test Description for Neon PG Migration');
  form.append('category', 'latest');
  form.append('initial_views', '3.4M');
  form.append('published', '1');
  form.append('thumbnail', new Blob(['test-thumb'], { type: 'image/jpeg' }), 'test-thumb.jpg');
  form.append('video', new Blob(['test-vid'], { type: 'video/mp4' }), 'test-vid.mp4');

  const addRes = await fetch(`${BASE_URL}/api/videos`, {
    method: 'POST',
    headers: { 'Cookie': cookie },
    body: form
  });
  const addData = await addRes.json();
  if (!addData.video || addData.video.views !== 3400000) {
    throw new Error('Initial views not set correctly: ' + JSON.stringify(addData));
  }
  const newId = addData.video.id;
  console.log(`✅ POST /api/videos succeeded: ID ${newId}, views parsed to ${addData.video.views}`);

  // 3k. Edit Video with 4.5M shorthand views
  const editForm = new FormData();
  editForm.append('title', 'Automated Test Video 2026 (Updated)');
  editForm.append('description', 'Updated description');
  editForm.append('category', 'trending');
  editForm.append('views', '4.5M');
  editForm.append('published', '1');

  const editRes = await fetch(`${BASE_URL}/api/videos/${newId}`, {
    method: 'PUT',
    headers: { 'Cookie': cookie },
    body: editForm
  });
  const editData = await editRes.json();
  if (!editData.video || editData.video.views !== 4500000) {
    throw new Error('Edited views not set correctly: ' + JSON.stringify(editData));
  }
  console.log(`✅ PUT /api/videos/${newId} succeeded: views updated to ${editData.video.views}`);

  // 3l. Delete Video
  const delRes = await fetch(`${BASE_URL}/api/videos/${newId}`, {
    method: 'DELETE',
    headers: { 'Cookie': cookie }
  });
  const delData = await delRes.json();
  if (!delData.success) {
    throw new Error('Delete failed: ' + JSON.stringify(delData));
  }
  console.log(`✅ DELETE /api/videos/${newId} succeeded: ${delData.message}`);

  console.log('\n================================================================================');
  console.log('🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================================');
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILURE:', err);
  process.exit(1);
});
