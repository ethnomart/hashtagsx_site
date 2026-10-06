import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD environment variable is required.');
  process.exit(1);
}

const STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'];

// ---------- storage: Postgres in production, JSON file when DATABASE_URL is not set (local testing) ----------
let store;

if (DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      seq SERIAL PRIMARY KEY,
      id TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'new',
      data JSONB NOT NULL
    )`);
  const rowToOrder = (r) => ({ ...r.data, id: r.id, createdAt: r.created_at.toISOString(), status: r.status });
  store = {
    async list() {
      const { rows } = await pool.query('SELECT * FROM orders ORDER BY seq DESC');
      return rows.map(rowToOrder);
    },
    async create(order) {
      const n = (await pool.query("SELECT nextval(pg_get_serial_sequence('orders','seq')) AS n")).rows[0].n;
      const id = 'HX-' + (1000 + Number(n));
      await pool.query('INSERT INTO orders (seq, id, data) VALUES ($1, $2, $3)', [n, id, order]);
      return id;
    },
    async setStatus(id, status) {
      const { rows } = await pool.query('UPDATE orders SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
      return rows[0] ? rowToOrder(rows[0]) : null;
    },
  };
  console.log('Using Postgres storage');
} else {
  const FILE = path.join(__dirname, 'orders.json');
  const read = () => {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
  };
  const write = (o) => fs.writeFileSync(FILE, JSON.stringify(o, null, 2));
  store = {
    async list() { return read().reverse(); },
    async create(order) {
      const orders = read();
      const id = 'HX-' + (orders.length + 1001);
      orders.push({ ...order, id, createdAt: new Date().toISOString(), status: 'new' });
      write(orders);
      return id;
    },
    async setStatus(id, status) {
      const orders = read();
      const o = orders.find((x) => x.id === id);
      if (!o) return null;
      o.status = status;
      write(orders);
      return o;
    },
  };
  console.log('DATABASE_URL not set: using local orders.json (data is lost on most hosts, use Postgres in production)');
}

// ---------- helpers ----------
const corsHeaders = (req) => {
  const origin = (req.headers.origin || '').replace(/\/$/, '');
  const allowed = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
  return allowed
    ? {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        Vary: 'Origin',
      }
    : {};
};

const send = (req, res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(req) });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); }
    });
  });

const isAdmin = (req) => {
  const given = crypto.createHash('sha256').update((req.headers.authorization || '').replace(/^Bearer /, '')).digest();
  const real = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(given, real);
};

// light brute-force guard on admin routes: 20 failed attempts per IP per 15 minutes
const fails = new Map();
const blocked = (ip) => {
  const f = fails.get(ip);
  return f && f.count >= 20 && Date.now() - f.since < 15 * 60 * 1000;
};
const noteFail = (ip) => {
  const f = fails.get(ip);
  if (!f || Date.now() - f.since > 15 * 60 * 1000) fails.set(ip, { count: 1, since: Date.now() });
  else f.count++;
};

const str = (v, max) => String(v ?? '').trim().slice(0, max);

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }

    if (url.pathname === '/' || url.pathname === '/health') return send(req, res, 200, { ok: true, service: 'hashtagsx-api' });

    if (url.pathname === '/api/orders' && req.method === 'POST') {
      const b = await readBody(req);
      const items = Array.isArray(b.items)
        ? b.items.slice(0, 50).map((i) => ({
            id: str(i.id, 80),
            title: str(i.title, 120),
            size: str(i.size, 20),
            quantity: Math.max(1, Math.min(99, Number(i.quantity) || 1)),
            price: Number(i.price) || 0,
          }))
        : [];
      const customer = {
        name: str(b.name, 100),
        phone: str(b.phone, 30),
        email: str(b.email, 120),
        address: str(b.address, 300),
        city: str(b.city, 80),
        notes: str(b.notes, 500),
      };
      if (!items.length || !customer.name || !customer.phone || !customer.address || !customer.city) {
        return send(req, res, 400, { error: 'Name, phone, address, city and at least one item are required.' });
      }
      const order = {
        customer,
        items,
        subtotal: Number(b.subtotal) || 0,
        discount: Number(b.discount) || 0,
        shipping: Number(b.shipping) || 0,
        total: Number(b.total) || 0,
        payment: 'Cash on delivery',
      };
      const id = await store.create(order);
      console.log(`New order ${id} from ${customer.name}, total ${order.total}`);
      return send(req, res, 201, { id });
    }

    if (url.pathname.startsWith('/api/orders')) {
      if (blocked(ip)) return send(req, res, 429, { error: 'Too many attempts. Try again later.' });
      if (!isAdmin(req)) {
        noteFail(ip);
        return send(req, res, 401, { error: 'Unauthorized' });
      }
      if (url.pathname === '/api/orders' && req.method === 'GET') return send(req, res, 200, await store.list());
      const m = url.pathname.match(/^\/api\/orders\/([\w-]+)$/);
      if (m && req.method === 'PATCH') {
        const { status } = await readBody(req);
        if (!STATUSES.includes(status)) return send(req, res, 400, { error: 'Bad status' });
        const o = await store.setStatus(m[1], status);
        return o ? send(req, res, 200, o) : send(req, res, 404, { error: 'Not found' });
      }
    }

    send(req, res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(req, res, 400, { error: 'Bad request' });
  }
});

server.listen(PORT, () => console.log(`HashtagsX API listening on ${PORT}`));
