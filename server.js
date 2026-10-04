/**
 * server.js
 * Express + SQLite Content Management System for ViralHub 2026
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { initDatabase, query, isPostgres } = require('./database/db');
const { isBlobConfigured, isBlobUrl, safeDeleteBlob, handleUpload } = require('./services/blob');
const {
  PLAN_PRICE,
  getPublicConfig,
  verifySubscriberToken,
  hasActiveSubscription,
  createSubscription,
  verifyAndActivateSubscription,
  handleWebhookEvent,
  restoreAccess,
  getAdminSubscriptions
} = require('./services/subscription');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'viralhub_2026_cms_secret_key_8f3a1b';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Ensure upload folders exist (with safe handling for read-only serverless filesystems)
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const VIDEOS_DIR = path.join(UPLOADS_DIR, 'videos');
const THUMBS_DIR = path.join(UPLOADS_DIR, 'thumbnails');
[UPLOADS_DIR, VIDEOS_DIR, THUMBS_DIR].forEach(dir => {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    // Graceful fallback on read-only serverless filesystems (e.g. Vercel)
  }
});

// Configure Multer for File Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let dest = file.fieldname === 'video' ? VIDEOS_DIR : THUMBS_DIR;
    try {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    } catch (_) {
      dest = os.tmpdir();
    }
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    // Generate safe, collision-resistant unique filename
    const ext = path.extname(file.originalname).toLowerCase();
    const prefix = file.fieldname === 'video' ? 'video' : 'thumb';
    const uniqueId = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    cb(null, `${prefix}_${uniqueId}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (file.fieldname === 'thumbnail') {
    const validImageExts = ['.jpg', '.jpeg', '.png', '.webp'];
    const validImageMimes = ['image/jpeg', 'image/png', 'image/webp'];
    if (validImageExts.includes(ext) || validImageMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid image format. Allowed formats: JPG, JPEG, PNG, WebP.'));
    }
  } else if (file.fieldname === 'video') {
    const validVideoExts = ['.mp4', '.webm'];
    const validVideoMimes = ['video/mp4', 'video/webm', 'application/octet-stream'];
    if (validVideoExts.includes(ext) || validVideoMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid video format. Allowed formats: MP4, WebM.'));
    }
  } else {
    cb(new Error('Unexpected upload field'));
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB max video size
  }
});

// Middleware to conditionally parse multipart/form-data only when files are being uploaded
function conditionalUpload(req, res, next) {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    return upload.fields([
      { name: 'thumbnail', maxCount: 1 },
      { name: 'video', maxCount: 1 }
    ])(req, res, next);
  }
  next();
}

// Middlewares
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(SESSION_SECRET));

// Assign persistent visitor identifier cookie for subscription association
app.use((req, res, next) => {
  if (!req.cookies.vh_uid) {
    const uid = 'usr_' + crypto.randomBytes(12).toString('hex');
    res.cookie('vh_uid', uid, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax'
    });
    req.cookies.vh_uid = uid;
  }
  next();
});

// Protect raw video uploads directory against direct unauthorized downloads
app.use('/uploads/videos', async (req, res, next) => {
  const isSub = await resolveIsSubscribed(req);
  if (!isSub) {
    return res.status(403).json({
      error: 'Active subscription required to access raw video files',
      locked: true,
      price: PLAN_PRICE
    });
  }
  next();
}, express.static(path.join(__dirname, 'uploads', 'videos')));

// Serve thumbnails and public static assets
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Legacy asset path fallback for backwards compatibility
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/js', express.static(path.join(__dirname, 'js')));

// Helper to determine if current requester has active subscriber access (or admin preview)
async function resolveIsSubscribed(req) {
  // 1. Authenticated Admin gets preview access
  if (verifyAuthToken(req.cookies.admin_token)) {
    return true;
  }

  // 2. Verified subscriber session token cookie
  const subToken = req.cookies.vh_sub_token;
  if (subToken) {
    const payload = verifySubscriberToken(subToken);
    if (payload) {
      const active = await hasActiveSubscription(payload.user_id, payload.email);
      if (active) return true;
    }
  }

  // 3. Fallback: visitor identifier cookie
  const visitorId = req.cookies.vh_uid;
  if (visitorId) {
    const active = await hasActiveSubscription(visitorId);
    if (active) return true;
  }

  return false;
}

// --- Database readiness helper (ensures DB initialized both locally & in Vercel serverless cold starts) ---
let dbInitPromise = null;
function ensureDbReady() {
  if (!dbInitPromise) {
    dbInitPromise = initDatabase().catch((err) => {
      dbInitPromise = null; // allow retry if initial attempt failed
      throw err;
    });
  }
  return dbInitPromise;
}

app.use(async (req, res, next) => {
  try {
    await ensureDbReady();
    next();
  } catch (err) {
    console.error('Database connection/initialization error:', err);
    res.status(500).json({ error: 'Database service unavailable. Please verify DATABASE_URL.' });
  }
});

// --- Admin Authentication Helper & Middlewares ---
function createAuthToken() {
  const data = `${ADMIN_USERNAME}:${Date.now()}`;
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
  return `${Buffer.from(data).toString('base64')}.${hmac}`;
}

function verifyAuthToken(token) {
  if (!token) return false;
  try {
    const [b64, hmac] = token.split('.');
    if (!b64 || !hmac) return false;
    const expectedHmac = crypto.createHmac('sha256', SESSION_SECRET).update(Buffer.from(b64, 'base64').toString('utf8')).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac));
  } catch (e) {
    return false;
  }
}

// Middleware to protect admin page
function requireAdminPage(req, res, next) {
  const token = req.cookies.admin_token;
  if (verifyAuthToken(token)) {
    return next();
  }
  return res.redirect('/admin/login');
}

// Middleware to protect admin API endpoints
function requireAdminApi(req, res, next) {
  const token = req.cookies.admin_token;
  if (verifyAuthToken(token)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Please log in as admin.' });
}

// ==========================================================================
// 1. PUBLIC ROUTES & APIS
// ==========================================================================

// Robust static HTML path resolver across local and Vercel environments
function getPublicPath(filename) {
  const p1 = path.join(__dirname, 'public', filename);
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(process.cwd(), 'public', filename);
  if (fs.existsSync(p2)) return p2;
  return p1;
}

// Public Homepage
app.get('/', (req, res) => {
  res.sendFile(getPublicPath('index.html'));
});

// Dedicated Public Video Detail Page (e.g. /video/1)
app.get('/video/:id', (req, res) => {
  res.sendFile(getPublicPath('video.html'));
});

// Public API: Fetch Published Videos (Newest first, supports category & search)
app.get('/api/videos', async (req, res) => {
  try {
    const { category, search } = req.query;

    let sql = `
      SELECT 
        id, 
        title, 
        description, 
        category, 
        COALESCE(thumbnail_url, thumbnail_path) AS thumbnail_path, 
        COALESCE(thumbnail_url, thumbnail_path) AS thumbnail_url, 
        duration, 
        published, 
        views, 
        created_at
      FROM videos 
      WHERE published = true
    `;
    const params = [];

    // Filter by search keyword (case-insensitive parameterized)
    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      const pIdx = params.length;
      sql += ` AND (title ILIKE $${pIdx} OR description ILIKE $${pIdx})`;
    }

    // Filter/Sort by category
    if (category && category !== 'latest' && category !== 'all') {
      if (category === 'trending') {
        sql += ' ORDER BY views DESC, id DESC';
      } else if (category === 'most-viewed') {
        sql += ' ORDER BY views DESC';
      } else if (category === 'new') {
        sql += " AND (category = 'new' OR created_at >= NOW() - INTERVAL '7 days') ORDER BY created_at DESC";
      } else {
        params.push(category);
        sql += ` AND category = $${params.length} ORDER BY created_at DESC`;
      }
    } else {
      // Default: LATEST (newest first)
      sql += ' ORDER BY created_at DESC, id DESC';
    }

    const videos = await query.all(sql, params);
    const formatted = videos.map(v => ({
      ...v,
      video_url: null,
      video_path: null,
      published: v.published === true || v.published === 1 ? 1 : 0
    }));
    res.json(formatted);
  } catch (err) {
    console.error('Error in GET /api/videos:', err);
    res.status(500).json({ error: 'Failed to retrieve published videos' });
  }
});

// Public API: Fetch single published video detail and increment view count
app.get('/api/videos/:id', async (req, res) => {
  try {
    const videoId = parseInt(req.params.id, 10);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    // Must be published to view publicly
    const video = await query.get(
      `SELECT 
         id, 
         title, 
         description, 
         category, 
         COALESCE(video_url, video_path) AS video_path, 
         COALESCE(video_url, video_path) AS video_url, 
         COALESCE(thumbnail_url, thumbnail_path) AS thumbnail_path, 
         COALESCE(thumbnail_url, thumbnail_path) AS thumbnail_url, 
         duration, 
         published, 
         views, 
         created_at
       FROM videos 
       WHERE id = $1 AND published = true`,
      [videoId]
    );

    if (!video) {
      return res.status(404).json({ error: 'Video not found or unpublished' });
    }

    // Anti-fraud / repeat refresh protection:
    // Only increment views if not viewed recently by this client (15-minute window)
    const viewedCookie = `viewed_vid_${videoId}`;
    const alreadyViewed = req.cookies && req.cookies[viewedCookie];

    if (!alreadyViewed) {
      // Atomic safe increment in PostgreSQL: views = views + 1
      const updateRes = await query.get(
        'UPDATE videos SET views = views + 1 WHERE id = $1 RETURNING views',
        [videoId]
      );
      if (updateRes && updateRes.views !== undefined) {
        video.views = Number(updateRes.views);
      } else {
        video.views = Number(video.views) + 1;
      }

      // Set cookie to prevent counting duplicate page refreshes repeatedly
      res.cookie(viewedCookie, '1', {
        maxAge: 15 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax'
      });
    }

    // Fetch related published videos (up to 6)
    const related = await query.all(
      `SELECT 
         id, 
         title, 
         COALESCE(video_url, video_path) AS video_path, 
         COALESCE(video_url, video_path) AS video_url, 
         COALESCE(thumbnail_url, thumbnail_path) AS thumbnail_path, 
         COALESCE(thumbnail_url, thumbnail_path) AS thumbnail_url, 
         category, 
         duration, 
         views, 
         created_at 
       FROM videos 
       WHERE published = true AND id != $1 
       ORDER BY created_at DESC 
       LIMIT 6`,
      [videoId]
    );

    const isSub = await resolveIsSubscribed(req);
    video.published = video.published === true || video.published === 1 ? 1 : 0;

    if (isSub) {
      video.is_locked = false;
      video.video_url = `/api/videos/${videoId}/stream`;
      video.video_path = `/api/videos/${videoId}/stream`;
    } else {
      video.is_locked = true;
      video.video_url = null;
      video.video_path = null;
    }

    const formattedRelated = related.map(r => ({
      ...r,
      video_url: null,
      video_path: null,
      published: r.published === true || r.published === 1 ? 1 : 0
    }));

    res.json({
      video,
      related: formattedRelated,
      subscription: {
        active: isSub,
        plan_price: PLAN_PRICE
      }
    });
  } catch (err) {
    console.error(`Error in GET /api/videos/${req.params.id}:`, err);
    res.status(500).json({ error: 'Failed to retrieve video details' });
  }
});

// Protected Video Streaming Route (requires verified active subscription)
app.get('/api/videos/:id/stream', async (req, res) => {
  try {
    const videoId = parseInt(req.params.id, 10);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    const isSub = await resolveIsSubscribed(req);
    if (!isSub) {
      return res.status(403).json({
        error: 'Active subscription required to watch this video',
        locked: true,
        price: PLAN_PRICE
      });
    }

    const video = await query.get(
      'SELECT id, title, video_url, video_path FROM videos WHERE id = $1 AND published = true',
      [videoId]
    );

    if (!video) {
      return res.status(404).json({ error: 'Video not found or unpublished' });
    }

    const targetUrl = video.video_url || video.video_path;

    // Remote Vercel Blob URL Streaming Proxy
    if (isBlobUrl(targetUrl)) {
      const fetchHeaders = {};
      if (req.headers.range) {
        fetchHeaders['Range'] = req.headers.range;
      }
      const upstreamRes = await fetch(targetUrl, { headers: fetchHeaders });
      res.status(upstreamRes.status);
      ['content-range', 'accept-ranges', 'content-length', 'content-type'].forEach(h => {
        const val = upstreamRes.headers.get(h);
        if (val) res.setHeader(h, val);
      });
      if (!res.getHeader('content-type')) {
        res.setHeader('content-type', 'video/mp4');
      }
      const { Readable } = require('stream');
      const readableStream = Readable.fromWeb(upstreamRes.body);
      return readableStream.pipe(res);
    }

    // Local Disk Streaming with HTTP 206 Partial Content Support
    let localFilePath = targetUrl;
    if (localFilePath.startsWith('/uploads/')) {
      localFilePath = path.join(__dirname, localFilePath);
    } else if (!path.isAbsolute(localFilePath)) {
      localFilePath = path.join(__dirname, 'uploads', 'videos', path.basename(localFilePath));
    }

    if (!fs.existsSync(localFilePath)) {
      return res.status(404).json({ error: 'Video file missing on server' });
    }

    const stat = fs.statSync(localFilePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize) {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
        return res.end();
      }

      if (end >= fileSize) {
        end = fileSize - 1;
      }

      const chunksize = (end - start) + 1;
      const fileStream = fs.createReadStream(localFilePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4'
      });
      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes'
      });
      fs.createReadStream(localFilePath).pipe(res);
    }
  } catch (err) {
    console.error(`Error in GET /api/videos/${req.params.id}/stream:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream video' });
    }
  }
});

// ==========================================================================
// SUBSCRIPTION & RAZORPAY API ROUTES
// ==========================================================================

// Safe public subscription configuration (Razorpay Key ID, Plan ID, Price)
app.get('/api/subscription/config', (req, res) => {
  res.json(getPublicConfig());
});

// Subscription status check for current visitor
app.get('/api/subscription/status', async (req, res) => {
  try {
    const isSub = await resolveIsSubscribed(req);
    let email = '';
    let expiresAt = null;

    if (req.cookies.vh_sub_token) {
      const payload = verifySubscriberToken(req.cookies.vh_sub_token);
      if (payload) {
        email = payload.email || '';
        const sub = await hasActiveSubscription(payload.user_id, payload.email);
        if (sub) {
          expiresAt = sub.current_period_end;
        }
      }
    }

    res.json({
      subscribed: isSub,
      status: isSub ? 'active' : 'inactive',
      plan_price: PLAN_PRICE,
      email: email,
      expires_at: expiresAt
    });
  } catch (err) {
    console.error('Error in /api/subscription/status:', err);
    res.status(500).json({ error: 'Failed to check subscription status' });
  }
});

// Create/start Razorpay subscription
app.post('/api/subscription/create', async (req, res) => {
  try {
    const { email, phone } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email address is required to subscribe' });
    }

    const userId = req.cookies.vh_uid || 'usr_' + crypto.randomBytes(8).toString('hex');
    const result = await createSubscription({ user_id: userId, email, phone });

    res.json(result);
  } catch (err) {
    console.error('Error in /api/subscription/create:', err);
    res.status(500).json({ error: err.message || 'Failed to create subscription' });
  }
});

// Verify subscription payment and activate subscriber session
app.post('/api/subscription/verify', async (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_subscription_id,
      razorpay_signature,
      email,
      phone
    } = req.body;

    if (!razorpay_subscription_id) {
      return res.status(400).json({ error: 'Missing subscription ID' });
    }

    const userId = req.cookies.vh_uid || 'usr_' + crypto.randomBytes(8).toString('hex');

    const verification = await verifyAndActivateSubscription({
      razorpay_payment_id,
      razorpay_subscription_id,
      razorpay_signature,
      user_id: userId,
      email,
      phone
    });

    // Set secure HTTP-only cookie with subscriber session token
    res.cookie('vh_sub_token', verification.token, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    });

    res.json({
      success: true,
      message: 'Subscription successfully activated! Premium access granted.',
      subscribed: true,
      subscription_id: razorpay_subscription_id
    });
  } catch (err) {
    console.error('Error in /api/subscription/verify:', err);
    res.status(400).json({ error: err.message || 'Subscription verification failed' });
  }
});

// Restore subscription access using email or subscription ID
app.post('/api/subscription/restore', async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier || !identifier.trim()) {
      return res.status(400).json({ error: 'Email or subscription ID is required' });
    }

    const restored = await restoreAccess(identifier.trim());
    if (!restored) {
      return res.status(404).json({
        success: false,
        error: 'No active subscription found for that email or subscription ID.'
      });
    }

    res.cookie('vh_sub_token', restored.token, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    });

    res.json({
      success: true,
      message: 'Subscription restored successfully! Premium access active.',
      subscribed: true,
      expires_at: restored.subscription.current_period_end
    });
  } catch (err) {
    console.error('Error in /api/subscription/restore:', err);
    res.status(500).json({ error: 'Failed to restore subscription' });
  }
});

// Secure Razorpay Webhook Endpoint
app.post('/api/webhook/razorpay', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody || JSON.stringify(req.body);

    const result = await handleWebhookEvent(rawBody, signature);
    res.json(result);
  } catch (err) {
    console.error('Webhook processing error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Admin Subscriptions API (Protected)
app.get('/api/admin/subscriptions', requireAdminApi, async (req, res) => {
  try {
    const data = await getAdminSubscriptions();
    res.json(data);
  } catch (err) {
    console.error('Error fetching admin subscriptions:', err);
    res.status(500).json({ error: 'Failed to fetch subscriptions' });
  }
});

// ==========================================================================
// 2. ADMIN AUTHENTICATION ROUTES & APIS
// ==========================================================================

// Helper: Parse flexible view count (handles plain numbers and shorthand like 2K, 3.4M)
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

  if (str.startsWith('-')) {
    throw new Error('View count cannot be negative.');
  }

  // Shorthand K / k (e.g. 2K, 3.4k, 750K)
  const kMatch = str.match(/^(\d+(?:\.\d+)?)\s*[kK]$/);
  if (kMatch) {
    const val = parseFloat(kMatch[1]);
    if (isNaN(val) || val < 0) throw new Error('Invalid view count value.');
    return Math.round(val * 1000);
  }

  // Shorthand M / m (e.g. 2M, 3.4m, 1.5M)
  const mMatch = str.match(/^(\d+(?:\.\d+)?)\s*[mM]$/);
  if (mMatch) {
    const val = parseFloat(mMatch[1]);
    if (isNaN(val) || val < 0) throw new Error('Invalid view count value.');
    return Math.round(val * 1000000);
  }

  // Plain number (accepts digits, optional standard thousands commas)
  const cleanNumber = str.replace(/,/g, '');
  if (/^\d+$/.test(cleanNumber)) {
    const val = parseInt(cleanNumber, 10);
    if (isNaN(val) || val < 0) throw new Error('Invalid view count value.');
    return val;
  }

  throw new Error(`Invalid view count "${str}". Enter a number (e.g. 1000) or shorthand (e.g. 2K, 3.4M).`);
}

// Admin Login Page (Always shows login page and requires credentials)
app.get('/admin/login', (req, res) => {
  res.clearCookie('admin_token');
  res.sendFile(getPublicPath('admin-login.html'));
});

// Admin Dashboard Page (Protected)
app.get('/admin', requireAdminPage, (req, res) => {
  res.sendFile(getPublicPath('admin.html'));
});

// Admin Login Action
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = createAuthToken();
    res.cookie('admin_token', token, {
      httpOnly: true,
      secure: false, // Set to true if running with HTTPS
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    return res.json({ success: true, message: 'Logged in successfully' });
  }

  return res.status(401).json({ error: 'Invalid username or password' });
});

// Admin Logout Action
app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.json({ success: true, message: 'Logged out successfully' });
});

// Admin Check Auth State
app.get('/api/admin/check-auth', (req, res) => {
  const authenticated = verifyAuthToken(req.cookies.admin_token);
  res.json({ authenticated });
});

// ==========================================================================
// 3. ADMIN MANAGEMENT APIS (PROTECTED)
// ==========================================================================

// Get Dashboard Stats
app.get('/api/admin/stats', requireAdminApi, async (req, res) => {
  try {
    const statsRow = await query.get(`
      SELECT 
        COUNT(*)::int AS "totalVideos",
        COUNT(*) FILTER (WHERE published = true)::int AS "publishedVideos",
        COUNT(*) FILTER (WHERE published = false)::int AS "unpublishedVideos",
        COALESCE(SUM(views), 0)::bigint AS "totalViews"
      FROM videos
    `);

    res.json({
      totalVideos: Number(statsRow?.totalVideos ?? statsRow?.totalvideos ?? 0),
      publishedVideos: Number(statsRow?.publishedVideos ?? statsRow?.publishedvideos ?? 0),
      unpublishedVideos: Number(statsRow?.unpublishedVideos ?? statsRow?.unpublishedvideos ?? 0),
      totalViews: Number(statsRow?.totalViews ?? statsRow?.totalviews ?? 0)
    });
  } catch (err) {
    console.error('Error in GET /api/admin/stats:', err);
    res.status(500).json({ error: 'Failed to retrieve stats' });
  }
});

// Get All Videos (Both published and unpublished)
app.get('/api/admin/videos', requireAdminApi, async (req, res) => {
  try {
    const videos = await query.all(`
      SELECT 
        id, 
        title, 
        description, 
        category, 
        COALESCE(video_url, video_path) AS video_path, 
        COALESCE(video_url, video_path) AS video_url, 
        COALESCE(thumbnail_url, thumbnail_path) AS thumbnail_path, 
        COALESCE(thumbnail_url, thumbnail_path) AS thumbnail_url, 
        duration, 
        published, 
        views, 
        created_at
      FROM videos 
      ORDER BY created_at DESC, id DESC
    `);
    const formatted = videos.map(v => ({
      ...v,
      published: v.published === true || v.published === 1 ? 1 : 0
    }));
    res.json(formatted);
  } catch (err) {
    console.error('Error in GET /api/admin/videos:', err);
    res.status(500).json({ error: 'Failed to retrieve videos' });
  }
});

// ==========================================================================
// 3. VERCEL BLOB STORAGE APIS
// ==========================================================================

// Check if Vercel Blob Store is configured
app.get('/api/blob/status', (req, res) => {
  res.json({ enabled: isBlobConfigured() });
});

// Direct Client Upload Token Generation (For large video / thumbnail direct uploads)
app.post('/api/blob/upload', requireAdminApi, async (req, res) => {
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload, multipart) => {
        return {
          allowedContentTypes: [
            'video/mp4', 'video/webm', 'video/quicktime',
            'image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'
          ],
          maximumSizeInBytes: 500 * 1024 * 1024, // 500MB max video size
          addRandomSuffix: true
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log('✅ Vercel Blob client upload completed:', blob.pathname);
      }
    });

    return res.json(jsonResponse);
  } catch (error) {
    console.error('Blob upload error:', error.message);
    return res.status(400).json({ error: error.message });
  }
});

// ==========================================================================
// 4. VIDEO MANAGEMENT APIS (PROTECTED)
// ==========================================================================

// Create New Video (Supports direct Vercel Blob URLs or local multipart upload fallback)
app.post('/api/videos', requireAdminApi, conditionalUpload, async (req, res) => {
  try {
    const { title, description, category, published, initial_views } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Video title is required' });
    }

    // Validate initial_views using flexible shorthand parser (e.g. 10K, 2M, 3.4M, 1000)
    let initialViews = 0;
    try {
      initialViews = parseViewCount(initial_views, true);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    let thumbnail_url = req.body.thumbnail_url || req.body.thumbnail_path || '';
    let video_url = req.body.video_url || req.body.video_path || '';

    // If files were uploaded via multipart form data:
    if (req.files && req.files.thumbnail && req.files.thumbnail.length > 0) {
      thumbnail_url = `/uploads/thumbnails/${req.files.thumbnail[0].filename}`;
    }
    if (req.files && req.files.video && req.files.video.length > 0) {
      video_url = `/uploads/videos/${req.files.video[0].filename}`;
    }

    if (!thumbnail_url) {
      return res.status(400).json({ error: 'Thumbnail image is required' });
    }

    if (!video_url) {
      return res.status(400).json({ error: 'Video file is required' });
    }

    const isPublished = published === '1' || published === 1 || published === 'true' || published === true ? 1 : 0;
    const cat = category || 'latest';

    const result = await query.get(
      `INSERT INTO videos (
         title, 
         description, 
         video_url, 
         video_path, 
         thumbnail_url, 
         thumbnail_path, 
         category, 
         duration, 
         published, 
         views
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        title.trim(),
        description ? description.trim() : '',
        video_url,
        video_url,
        thumbnail_url,
        thumbnail_url,
        cat,
        '03:45',
        Boolean(isPublished),
        initialViews
      ]
    );

    const newVideo = {
      ...result,
      views: Number(result.views || 0),
      published: result.published === true || result.published === 1 ? 1 : 0
    };
    console.log(`🎬 New video added: ID ${newVideo.id} - "${newVideo.title}"`);
    res.status(201).json({ success: true, video: newVideo });
  } catch (err) {
    console.error('Error in POST /api/videos:', err);
    res.status(500).json({ error: err.message || 'Server error while uploading video' });
  }
});

// Edit Video Details (Supports title, desc, category, status, flexible views, thumbnail, and video)
app.put('/api/videos/:id', requireAdminApi, conditionalUpload, async (req, res) => {
  try {
    const videoId = parseInt(req.params.id, 10);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    const existingVideo = await query.get('SELECT * FROM videos WHERE id = $1', [videoId]);
    if (!existingVideo) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const { title, description, category, published, views } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Video title cannot be empty' });
    }

    // Validate views if provided (accepts plain numbers and shorthand like 2K, 3.4M)
    let updatedViews = existingVideo.views;
    if (views !== undefined && views !== null && views !== '') {
      try {
        updatedViews = parseViewCount(views, false);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    let thumbnail_url = req.body.thumbnail_url || existingVideo.thumbnail_url || existingVideo.thumbnail_path;
    let thumbReplaced = Boolean(req.body.thumbnail_url && req.body.thumbnail_url !== existingVideo.thumbnail_url);

    if (req.files && req.files.thumbnail && req.files.thumbnail.length > 0) {
      const thumbFile = req.files.thumbnail[0];
      thumbnail_url = `/uploads/thumbnails/${thumbFile.filename}`;
      thumbReplaced = true;
    }

    let video_url = req.body.video_url || existingVideo.video_url || existingVideo.video_path;
    let videoReplaced = Boolean(req.body.video_url && req.body.video_url !== existingVideo.video_url);

    if (req.files && req.files.video && req.files.video.length > 0) {
      const videoFile = req.files.video[0];
      video_url = `/uploads/videos/${videoFile.filename}`;
      videoReplaced = true;
    }

    const isPublished = published !== undefined ? (published === '1' || published === 1 || published === 'true' || published === true ? 1 : 0) : existingVideo.published;
    const cat = category || existingVideo.category;

    // 1. Update database record first
    const updated = await query.get(
      `UPDATE videos 
       SET 
         title = $1, 
         description = $2, 
         category = $3, 
         thumbnail_url = $4, 
         thumbnail_path = $5, 
         video_url = $6, 
         video_path = $7, 
         published = $8, 
         views = $9 
       WHERE id = $10
       RETURNING *`,
      [
        title.trim(),
        description !== undefined ? description.trim() : existingVideo.description,
        cat,
        thumbnail_url,
        thumbnail_url,
        video_url,
        video_url,
        Boolean(isPublished),
        updatedViews,
        videoId
      ]
    );

    // 2. Safely delete old Blob or local files ONLY AFTER database update succeeds
    if (thumbReplaced && existingVideo.thumbnail_url) {
      if (isBlobUrl(existingVideo.thumbnail_url)) {
        await safeDeleteBlob(existingVideo.thumbnail_url);
      } else if (existingVideo.thumbnail_path && existingVideo.thumbnail_path.startsWith('/uploads/thumbnails/')) {
        const oldFilename = path.basename(existingVideo.thumbnail_path);
        if (!oldFilename.startsWith('seed-thumb-')) {
          const oldFilePath = path.join(THUMBS_DIR, oldFilename);
          if (fs.existsSync(oldFilePath)) fs.unlink(oldFilePath, () => {});
        }
      }
    }

    if (videoReplaced && existingVideo.video_url) {
      if (isBlobUrl(existingVideo.video_url)) {
        await safeDeleteBlob(existingVideo.video_url);
      } else if (existingVideo.video_path && existingVideo.video_path.startsWith('/uploads/videos/')) {
        const oldVidName = path.basename(existingVideo.video_path);
        if (!oldVidName.startsWith('seed-video-')) {
          const oldVidPath = path.join(VIDEOS_DIR, oldVidName);
          if (fs.existsSync(oldVidPath)) fs.unlink(oldVidPath, () => {});
        }
      }
    }

    const updatedVideo = {
      ...updated,
      views: Number(updated.views || 0),
      published: updated.published === true || updated.published === 1 ? 1 : 0
    };
    console.log(`✏️ Video updated: ID ${videoId} - "${updatedVideo.title}" (Views: ${updatedVideo.views})`);
    res.json({ success: true, video: updatedVideo });
  } catch (err) {
    console.error(`Error in PUT /api/videos/${req.params.id}:`, err);
    res.status(500).json({ error: err.message || 'Failed to update video' });
  }
});

// Toggle Published Status
app.patch('/api/videos/:id/publish', requireAdminApi, async (req, res) => {
  try {
    const videoId = parseInt(req.params.id, 10);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    const video = await query.get('SELECT id, published FROM videos WHERE id = $1', [videoId]);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    let newPublishedBool;
    if (req.body && req.body.published !== undefined) {
      newPublishedBool = req.body.published === true || req.body.published === 1 || req.body.published === '1' || req.body.published === 'true';
    } else {
      newPublishedBool = !(video.published === true || video.published === 1);
    }

    const updated = await query.get(
      'UPDATE videos SET published = $1 WHERE id = $2 RETURNING id, published',
      [newPublishedBool, videoId]
    );

    const numericPub = updated && (updated.published === true || updated.published === 1) ? 1 : (newPublishedBool ? 1 : 0);
    console.log(`📢 Video ID ${videoId} published status changed to: ${numericPub}`);
    res.json({ success: true, published: numericPub });
  } catch (err) {
    console.error(`Error in PATCH /api/videos/${req.params.id}/publish:`, err);
    res.status(500).json({ error: 'Failed to update published status' });
  }
});

// Delete Video (Removes database record & associated files/blobs)
app.delete('/api/videos/:id', requireAdminApi, async (req, res) => {
  try {
    const videoId = parseInt(req.params.id, 10);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    const video = await query.get('SELECT * FROM videos WHERE id = $1', [videoId]);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // 1. Delete database record in PostgreSQL first
    await query.run('DELETE FROM videos WHERE id = $1', [videoId]);

    // 2. Delete associated Blob objects from Vercel Blob Store (if applicable)
    const blobUrlsToDelete = [];
    if (isBlobUrl(video.video_url)) blobUrlsToDelete.push(video.video_url);
    if (isBlobUrl(video.thumbnail_url)) blobUrlsToDelete.push(video.thumbnail_url);
    if (blobUrlsToDelete.length > 0) {
      await safeDeleteBlob(blobUrlsToDelete);
    }

    // 3. Delete local files gracefully (if not seed assets)
    if (video.video_path && video.video_path.startsWith('/uploads/videos/')) {
      const vFilename = path.basename(video.video_path);
      const vFilePath = path.join(VIDEOS_DIR, vFilename);
      if (fs.existsSync(vFilePath)) {
        fs.unlink(vFilePath, (err) => {
          if (err) console.error('Failed to unlink video file:', err.message);
        });
      }
    }

    if (video.thumbnail_path && video.thumbnail_path.startsWith('/uploads/thumbnails/')) {
      const tFilename = path.basename(video.thumbnail_path);
      if (!tFilename.startsWith('seed-thumb-')) {
        const tFilePath = path.join(THUMBS_DIR, tFilename);
        if (fs.existsSync(tFilePath)) {
          fs.unlink(tFilePath, (err) => {
            if (err) console.error('Failed to unlink thumbnail file:', err.message);
          });
        }
      }
    }

    console.log(`🗑️ Deleted video ID ${videoId} and associated files/blobs.`);
    res.json({ success: true, message: 'Video deleted successfully' });
  } catch (err) {
    console.error(`Error in DELETE /api/videos/${req.params.id}:`, err);
    res.status(500).json({ error: 'Failed to delete video' });
  }
});

// Error handling middleware (catches Multer file errors & unexpected errors)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File size exceeds maximum allowed limit (500MB).' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  } else if (err) {
    return res.status(400).json({ error: err.message || 'An unexpected error occurred' });
  }
  next();
});

// Start Server locally when executed directly
if (require.main === module) {
  ensureDbReady()
    .then(() => {
      app.listen(PORT, '127.0.0.1', () => {
        console.log(`Database: ${isPostgres ? 'PostgreSQL/Neon' : 'SQLite'}`);
        console.log(`🚀 ViralHub CMS Server running at: http://127.0.0.1:${PORT}/`);
        console.log(`🔑 Admin Login URL: http://127.0.0.1:${PORT}/admin/login`);
        console.log(`🌐 Public Website URL: http://127.0.0.1:${PORT}/`);
      });
    })
    .catch((err) => {
      console.error('Fatal error initializing database:', err);
      process.exit(1);
    });
}

// Export app for Vercel Serverless Function compatibility
module.exports = app;
