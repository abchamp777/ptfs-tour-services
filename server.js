require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const DISCORD_INVITE = process.env.DISCORD_INVITE || 'https://discord.gg/EH7F5WnwKH';
const OPERATIONS_PASSWORD = process.env.OPERATIONS_PASSWORD || 'change-this-password';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'America/New_York';
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

const MILEAGE_MIN = 100;
const MILEAGE_MAX = 700;
const BENEFITS = {
  Priority: {
    cost: 1500,
    description: 'Book a private tour without using the waitlist.'
  },
  Executive: {
    cost: 3000,
    description: 'Book a private flight without the waitlist and receive premium meals.'
  }
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(STORE_FILE)) {
  fs.writeFileSync(STORE_FILE, JSON.stringify({ tours: [], bookings: [], mileage: [], mileageTransactions: [] }, null, 2));
}

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    })
  : null;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function localRead() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return {
      tours: Array.isArray(data.tours) ? data.tours : [],
      bookings: Array.isArray(data.bookings) ? data.bookings : [],
      mileage: Array.isArray(data.mileage) ? data.mileage : [],
      mileageTransactions: Array.isArray(data.mileageTransactions) ? data.mileageTransactions : []
    };
  } catch {
    return { tours: [], bookings: [], mileage: [], mileageTransactions: [] };
  }
}

function localWrite(data) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
}

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tours (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'America/New_York',
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      aircraft TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Scheduled',
      start_timestamp BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      tour_id TEXT,
      tour_type TEXT NOT NULL,
      discord_username TEXT NOT NULL,
      roblox_username TEXT NOT NULL,
      passengers INTEGER NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'America/New_York',
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Pending',
      membership_tier TEXT NOT NULL DEFAULT 'None',
      meal_service TEXT NOT NULL DEFAULT 'Standard',
      confirmation_code TEXT,
      checked_in BOOLEAN NOT NULL DEFAULT FALSE,
      checked_in_at TIMESTAMPTZ,
      miles_awarded INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mileage_accounts (
      id TEXT PRIMARY KEY,
      discord_username TEXT NOT NULL,
      roblox_username TEXT NOT NULL,
      miles INTEGER NOT NULL DEFAULT 0,
      tier TEXT NOT NULL DEFAULT 'None',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(discord_username, roblox_username)
    );

    CREATE TABLE IF NOT EXISTS mileage_transactions (
      id TEXT PRIMARY KEY,
      discord_username TEXT NOT NULL,
      roblox_username TEXT NOT NULL,
      amount INTEGER NOT NULL,
      kind TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      booking_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS membership_tier TEXT NOT NULL DEFAULT 'None';
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS meal_service TEXT NOT NULL DEFAULT 'Standard';
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS confirmation_code TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/New_York';
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS miles_awarded INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tours ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/New_York';
    ALTER TABLE tours ADD COLUMN IF NOT EXISTS start_timestamp BIGINT;
  `);
}

function id(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function safeText(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeIdentity(value) {
  return safeText(value, 100).toLowerCase();
}

function randomMiles() {
  return Math.floor(Math.random() * (MILEAGE_MAX - MILEAGE_MIN + 1)) + MILEAGE_MIN;
}

function generateConfirmationCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function authToken() {
  const payload = `ops:${Date.now()}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function isAuthenticated(req) {
  const raw = req.headers.cookie || '';
  const match = raw.match(/(?:^|;\s*)ops_session=([^;]+)/);
  if (!match) return false;
  try {
    const decoded = Buffer.from(match[1], 'base64url').toString('utf8');
    const [payload, signature] = decoded.split('.');
    if (!payload || !signature) return false;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    if (signature.length !== expected.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
    const created = Number(payload.split(':')[1]);
    return Number.isFinite(created) && Date.now() - created < 1000 * 60 * 60 * 12;
  } catch {
    return false;
  }
}

function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Operations access required.' });
  next();
}

function zonedDateToTimestamp(date, time, timeZone) {
  const [year, month, day] = String(date).split('-').map(Number);
  const [hour, minute] = String(time).split(':').map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) throw new Error('Invalid date/time.');

  // Validate the IANA timezone and calculate the UTC offset for that date.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const zoneAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offset = zoneAsUtc - guess;
  return Math.floor((guess - offset) / 1000);
}

function getTourStartTimestamp(tour) {
  if (tour.start_timestamp && Number.isFinite(Number(tour.start_timestamp))) return Number(tour.start_timestamp);
  return zonedDateToTimestamp(tour.date, tour.time, tour.timezone || DEFAULT_TIMEZONE);
}

function normalizeTour(tour) {
  const normalized = { ...tour, timezone: tour.timezone || DEFAULT_TIMEZONE };
  try { normalized.start_timestamp = getTourStartTimestamp(normalized); } catch { normalized.start_timestamp = null; }
  return normalized;
}

function discordTourText(tour) {
  const timestamp = getTourStartTimestamp(tour);
  return `@everyone\n\n# ✈️ ${tour.title} #\n\n` +
    `🌎 **TOUR DETAILS**\n\n` +
    `📅 **Date:** <t:${timestamp}:D>\n` +
    `⏰ **Time:** <t:${timestamp}:t>\n` +
    `🕒 **Starts:** <t:${timestamp}:F> (<t:${timestamp}:R>)\n` +
    `🛫 **Route:** ${tour.origin} → ${tour.destination}\n` +
    `✈️ **Aircraft:** ${tour.aircraft}\n` +
    `👥 **Capacity:** ${tour.capacity}\n` +
    `🎟️ **Type:** ${tour.type}\n\n` +
    `${tour.description ? `${tour.description}\n\n` : ''}` +
    `🔗 **Book / Details:** ${SITE_URL}/#tours\n\n` +
    `PTFS Tour Services\n` +
    `Your Flight. Your Tour. Your Experience.`;
}

function bookingDiscordText(booking) {
  let timeBlock = `⏰ **Time:** ${booking.time}\n`;
  if (booking.timezone) {
    try {
      const timestamp = zonedDateToTimestamp(booking.date, booking.time, booking.timezone);
      timeBlock = `📅 **Date:** <t:${timestamp}:D>\n⏰ **Time:** <t:${timestamp}:t>\n🕒 **Starts:** <t:${timestamp}:F> (<t:${timestamp}:R>)\n`;
    } catch {}
  }
  return `# ✈️ PTFS Tour Booking Request\n\n` +
    `👤 **Discord:** ${booking.discord_username}\n` +
    `🎮 **Roblox:** ${booking.roblox_username}\n` +
    `👥 **Passengers:** ${booking.passengers}\n` +
    timeBlock +
    `🛫 **Route:** ${booking.origin} → ${booking.destination}\n` +
    `🎟️ **Type:** ${booking.tour_type}\n` +
    `⭐ **Membership:** ${booking.membership_tier || 'None'}\n` +
    `🍽️ **Meal Service:** ${booking.meal_service || 'Standard'}\n` +
    `🔖 **Confirmation:** ${booking.confirmation_code}\n` +
    `${booking.status === 'Waitlisted' ? '⏳ **Status:** Waitlisted\n' : ''}` +
    `${booking.notes ? `📝 **Notes:** ${booking.notes}\n` : ''}`;
}

async function getTours() {
  if (!pool) return localRead().tours.map(normalizeTour);
  const { rows } = await pool.query('SELECT * FROM tours ORDER BY date ASC, time ASC, created_at DESC');
  return rows.map(normalizeTour);
}

async function getBookings() {
  if (!pool) return localRead().bookings;
  const { rows } = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
  return rows;
}

async function getMileageAccount(discordUsername, robloxUsername) {
  const discord = normalizeIdentity(discordUsername);
  const roblox = normalizeIdentity(robloxUsername);
  if (!discord || !roblox) return null;

  if (!pool) {
    const data = localRead();
    return data.mileage.find(a => a.discord_username === discord && a.roblox_username === roblox) || null;
  }

  const { rows } = await pool.query(
    'SELECT * FROM mileage_accounts WHERE discord_username=$1 AND roblox_username=$2 LIMIT 1',
    [discord, roblox]
  );
  return rows[0] || null;
}

async function ensureMileageAccount(discordUsername, robloxUsername) {
  const discord = normalizeIdentity(discordUsername);
  const roblox = normalizeIdentity(robloxUsername);
  if (!discord || !roblox) throw new Error('Discord and Roblox usernames are required.');

  if (!pool) {
    const data = localRead();
    let account = data.mileage.find(a => a.discord_username === discord && a.roblox_username === roblox);
    if (!account) {
      account = { id: id('mileage'), discord_username: discord, roblox_username: roblox, miles: 0, tier: 'None' };
      data.mileage.push(account);
      localWrite(data);
    }
    return account;
  }

  const { rows } = await pool.query(
    `INSERT INTO mileage_accounts (id,discord_username,roblox_username,miles,tier)
     VALUES ($1,$2,$3,0,'None')
     ON CONFLICT (discord_username,roblox_username)
     DO UPDATE SET updated_at=NOW()
     RETURNING *`,
    [id('mileage'), discord, roblox]
  );
  return rows[0];
}

async function addMileage(account, amount, kind, description, bookingId = null) {
  if (!amount) return account;

  if (!pool) {
    const data = localRead();
    const stored = data.mileage.find(a => a.discord_username === account.discord_username && a.roblox_username === account.roblox_username);
    if (!stored) return account;
    stored.miles += amount;
    data.mileageTransactions.unshift({
      id: id('mile_tx'),
      discord_username: stored.discord_username,
      roblox_username: stored.roblox_username,
      amount,
      kind,
      description,
      booking_id: bookingId,
      created_at: new Date().toISOString()
    });
    localWrite(data);
    return stored;
  }

  await pool.query(
    'UPDATE mileage_accounts SET miles=miles+$1, updated_at=NOW() WHERE id=$2',
    [amount, account.id]
  );
  await pool.query(
    `INSERT INTO mileage_transactions (id,discord_username,roblox_username,amount,kind,description,booking_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id('mile_tx'), account.discord_username, account.roblox_username, amount, kind, description, bookingId]
  );
  return getMileageAccount(account.discord_username, account.roblox_username);
}

async function setMembership(discordUsername, robloxUsername, tier) {
  const account = await ensureMileageAccount(discordUsername, robloxUsername);
  if (!pool) {
    const data = localRead();
    const stored = data.mileage.find(a => a.id === account.id);
    stored.tier = tier;
    localWrite(data);
    return stored;
  }
  const { rows } = await pool.query(
    'UPDATE mileage_accounts SET tier=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
    [tier, account.id]
  );
  return rows[0];
}

async function getTourById(tourId) {
  if (!tourId) return null;
  if (!pool) return localRead().tours.find(t => t.id === tourId) || null;
  const { rows } = await pool.query('SELECT * FROM tours WHERE id=$1 LIMIT 1', [tourId]);
  return rows[0] || null;
}

async function countReservedSeats(tourId) {
  const activeStatuses = ['Pending', 'Confirmed', 'Boarding'];
  if (!pool) {
    return localRead().bookings
      .filter(b => b.tour_id === tourId && activeStatuses.includes(b.status))
      .reduce((sum, b) => sum + Number(b.passengers || 0), 0);
  }
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(passengers),0)::int AS seats FROM bookings WHERE tour_id=$1 AND status = ANY($2::text[])`,
    [tourId, activeStatuses]
  );
  return Number(rows[0]?.seats || 0);
}

async function getBookingById(bookingId) {
  if (!pool) return localRead().bookings.find(b => b.id === bookingId) || null;
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id=$1 LIMIT 1', [bookingId]);
  return rows[0] || null;
}

async function saveBooking(booking) {
  if (!pool) {
    const data = localRead();
    data.bookings.unshift(booking);
    localWrite(data);
    return booking;
  }
  const { rows } = await pool.query(
    `INSERT INTO bookings
      (id,tour_id,tour_type,discord_username,roblox_username,passengers,date,time,timezone,origin,destination,notes,status,membership_tier,meal_service,confirmation_code,checked_in,miles_awarded)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [booking.id, booking.tour_id || null, booking.tour_type, booking.discord_username, booking.roblox_username,
     booking.passengers, booking.date, booking.time, booking.timezone || DEFAULT_TIMEZONE, booking.origin, booking.destination, booking.notes,
     booking.status, booking.membership_tier, booking.meal_service, booking.confirmation_code,
     booking.checked_in, booking.miles_awarded]
  );
  return rows[0];
}

async function updateBooking(bookingId, updates) {
  if (!pool) {
    const data = localRead();
    const booking = data.bookings.find(b => b.id === bookingId);
    if (!booking) return null;
    Object.assign(booking, updates);
    localWrite(data);
    return booking;
  }

  const allowed = ['status','checked_in','checked_in_at','miles_awarded'];
  const entries = Object.entries(updates).filter(([key]) => allowed.includes(key));
  if (!entries.length) return getBookingById(bookingId);
  const set = entries.map(([key], i) => `${key}=$${i + 1}`).join(', ');
  const values = entries.map(([, value]) => value);
  values.push(bookingId);
  const { rows } = await pool.query(`UPDATE bookings SET ${set} WHERE id=$${values.length} RETURNING *`, values);
  return rows[0] || null;
}

async function promoteWaitlist(tourId) {
  const tour = await getTourById(tourId);
  if (!tour || tour.type !== 'Public') return;

  const available = Math.max(0, Number(tour.capacity) - await countReservedSeats(tourId));
  if (available <= 0) return;

  let waitlisted;
  if (!pool) {
    waitlisted = localRead().bookings
      .filter(b => b.tour_id === tourId && b.status === 'Waitlisted')
      .sort((a,b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  } else {
    const { rows } = await pool.query(
      `SELECT * FROM bookings WHERE tour_id=$1 AND status='Waitlisted' ORDER BY created_at ASC`,
      [tourId]
    );
    waitlisted = rows;
  }

  let seats = available;
  for (const booking of waitlisted) {
    if (Number(booking.passengers) <= seats) {
      await updateBooking(booking.id, { status: 'Pending' });
      seats -= Number(booking.passengers);
    }
    if (seats <= 0) break;
  }
}

async function awardMileageForBooking(booking) {
  if (!booking || booking.status !== 'Completed' || Number(booking.miles_awarded) > 0) return { miles: 0, account: null };
  const account = await ensureMileageAccount(booking.discord_username, booking.roblox_username);
  const miles = randomMiles();
  const updated = await addMileage(account, miles, 'flight', `Flight completed: ${booking.origin} → ${booking.destination}`, booking.id);
  await updateBooking(booking.id, { miles_awarded: miles });
  return { miles, account: updated };
}

app.get('/api/config', (req, res) => {
  res.json({ discordInvite: DISCORD_INVITE, siteUrl: SITE_URL, benefits: BENEFITS, mileageRange: [MILEAGE_MIN, MILEAGE_MAX] });
});

app.get('/api/tours', async (req, res) => {
  try { res.json(await getTours()); }
  catch (error) { console.error(error); res.status(500).json({ error: 'Could not load tours.' }); }
});

app.post('/api/operations/login', (req, res) => {
  const password = String(req.body.password || '');
  const expected = String(OPERATIONS_PASSWORD);
  const left = Buffer.from(password);
  const right = Buffer.from(expected);
  const valid = left.length === right.length && crypto.timingSafeEqual(left, right);
  if (!valid) return res.status(401).json({ error: 'Incorrect operations password.' });
  res.setHeader('Set-Cookie', `ops_session=${authToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.post('/api/operations/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'ops_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/operations/me', requireAuth, (req, res) => res.json({ authenticated: true }));

app.get('/api/operations/dashboard', requireAuth, async (req, res) => {
  try {
    const tours = await getTours();
    const bookings = await getBookings();
    res.json({ tours, bookings: bookings.map(b => ({ ...b, discordText: bookingDiscordText(b) })), benefits: BENEFITS, mileageRange: [MILEAGE_MIN, MILEAGE_MAX] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not load operations data.' });
  }
});

app.post('/api/tours', requireAuth, async (req, res) => {
  const tour = {
    id: id('tour'),
    title: safeText(req.body.title, 120),
    type: safeText(req.body.type, 30) || 'Public',
    date: safeText(req.body.date, 30),
    time: safeText(req.body.time, 30),
    timezone: safeText(req.body.timezone, 80) || DEFAULT_TIMEZONE,
    origin: safeText(req.body.origin, 120),
    destination: safeText(req.body.destination, 120),
    aircraft: safeText(req.body.aircraft, 100),
    capacity: Math.max(1, Math.min(999, Number(req.body.capacity) || 1)),
    description: safeText(req.body.description, 800),
    status: 'Scheduled'
  };

  if (!['Public','Private'].includes(tour.type)) return res.status(400).json({ error: 'Invalid tour type.' });
  if (!tour.title || !tour.date || !tour.time || !tour.origin || !tour.destination || !tour.aircraft) {
    return res.status(400).json({ error: 'Please complete all required tour fields.' });
  }

  let tourStart;
  try {
    tourStart = getTourStartDateTime(tour);
  } catch {
    return res.status(400).json({ error: 'Please choose a valid date, time, and timezone.' });
  }
  tour.start_timestamp = Math.floor(tourStart.toSeconds());

  try {
    if (!pool) {
      const data = localRead();
      data.tours.push(tour);
      localWrite(data);
    } else {
      await pool.query(
        `INSERT INTO tours (id,title,type,date,time,origin,destination,aircraft,capacity,description,status,timezone,start_timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [tour.id,tour.title,tour.type,tour.date,tour.time,tour.origin,tour.destination,tour.aircraft,tour.capacity,tour.description,tour.status,tour.timezone,tour.start_timestamp]
      );
    }
    res.status(201).json({ ...tour, discordText: discordTourText(tour) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not create the tour.' });
  }
});

app.patch('/api/tours/:id/status', requireAuth, async (req, res) => {
  const status = safeText(req.body.status, 30);
  if (!['Scheduled','Boarding','Completed','Cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  try {
    if (!pool) {
      const data = localRead();
      const tour = data.tours.find(t => t.id === req.params.id);
      if (!tour) return res.status(404).json({ error: 'Tour not found.' });
      tour.status = status;
      localWrite(data);
    } else {
      const { rows } = await pool.query('UPDATE tours SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Tour not found.' });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not update tour status.' });
  }
});

app.delete('/api/tours/:id', requireAuth, async (req, res) => {
  try {
    if (!pool) {
      const data = localRead();
      data.tours = data.tours.filter(t => t.id !== req.params.id);
      localWrite(data);
    } else {
      await pool.query('DELETE FROM tours WHERE id=$1', [req.params.id]);
    }
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not delete tour.' });
  }
});

app.get('/api/mileage', async (req, res) => {
  const discord = safeText(req.query.discord, 100);
  const roblox = safeText(req.query.roblox, 100);
  if (!discord || !roblox) return res.status(400).json({ error: 'Enter both your Discord and Roblox usernames.' });
  try {
    const account = await getMileageAccount(discord, roblox);
    res.json({
      discordUsername: discord,
      robloxUsername: roblox,
      miles: Number(account?.miles || 0),
      tier: account?.tier || 'None',
      benefits: BENEFITS,
      mileageRange: [MILEAGE_MIN, MILEAGE_MAX]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not load mileage.' });
  }
});

app.get('/api/operations/mileage', requireAuth, async (req, res) => {
  try {
    if (!pool) {
      const data = localRead();
      return res.json({ accounts: data.mileage.sort((a, b) => Number(b.miles || 0) - Number(a.miles || 0)) });
    }
    const { rows } = await pool.query('SELECT * FROM mileage_accounts ORDER BY miles DESC, updated_at DESC');
    res.json({ accounts: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not load mileage accounts.' });
  }
});

app.patch('/api/operations/mileage/:id/reset', requireAuth, async (req, res) => {
  try {
    if (!pool) {
      const data = localRead();
      const account = data.mileage.find(a => a.id === req.params.id);
      if (!account) return res.status(404).json({ error: 'Mileage member not found.' });
      account.miles = 0;
      account.tier = 'None';
      account.updated_at = new Date().toISOString();
      data.mileageTransactions = data.mileageTransactions.filter(tx => tx.discord_username !== account.discord_username || tx.roblox_username !== account.roblox_username);
      localWrite(data);
      return res.json({ ok: true, account });
    }

    const { rows } = await pool.query('SELECT * FROM mileage_accounts WHERE id=$1 LIMIT 1', [req.params.id]);
    const account = rows[0];
    if (!account) return res.status(404).json({ error: 'Mileage member not found.' });
    await pool.query('DELETE FROM mileage_transactions WHERE discord_username=$1 AND roblox_username=$2', [account.discord_username, account.roblox_username]);
    const updated = await pool.query("UPDATE mileage_accounts SET miles=0,tier='None',updated_at=NOW() WHERE id=$1 RETURNING *", [req.params.id]);
    res.json({ ok: true, account: updated.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not reset member mileage.' });
  }
});

app.delete('/api/operations/members/:id', requireAuth, async (req, res) => {
  try {
    if (!pool) {
      const data = localRead();
      const account = data.mileage.find(a => a.id === req.params.id);
      if (!account) return res.status(404).json({ error: 'Member not found.' });
      const discord = normalizeIdentity(account.discord_username);
      const roblox = normalizeIdentity(account.roblox_username);
      const affectedTourIds = [...new Set(data.bookings.filter(b => normalizeIdentity(b.discord_username) === discord && normalizeIdentity(b.roblox_username) === roblox && b.tour_id).map(b => b.tour_id))];
      data.bookings = data.bookings.filter(b => !(normalizeIdentity(b.discord_username) === discord && normalizeIdentity(b.roblox_username) === roblox));
      data.mileage = data.mileage.filter(a => a.id !== req.params.id);
      data.mileageTransactions = data.mileageTransactions.filter(tx => normalizeIdentity(tx.discord_username) !== discord || normalizeIdentity(tx.roblox_username) !== roblox);
      localWrite(data);
      for (const tourId of affectedTourIds) await promoteWaitlist(tourId);
      return res.json({ ok: true });
    }

    const { rows } = await pool.query('SELECT * FROM mileage_accounts WHERE id=$1 LIMIT 1', [req.params.id]);
    const account = rows[0];
    if (!account) return res.status(404).json({ error: 'Member not found.' });
    const bookings = await pool.query('SELECT id,tour_id,status FROM bookings WHERE lower(discord_username)=lower($1) AND lower(roblox_username)=lower($2)', [account.discord_username, account.roblox_username]);
    const affectedTourIds = [...new Set(bookings.rows.filter(b => b.tour_id && ['Pending','Waitlisted','Confirmed','Boarding'].includes(b.status)).map(b => b.tour_id))];
    await pool.query('DELETE FROM mileage_transactions WHERE discord_username=$1 AND roblox_username=$2', [account.discord_username, account.roblox_username]);
    await pool.query('DELETE FROM mileage_accounts WHERE id=$1', [req.params.id]);
    await pool.query('DELETE FROM bookings WHERE lower(discord_username)=lower($1) AND lower(roblox_username)=lower($2)', [account.discord_username, account.roblox_username]);
    for (const tourId of affectedTourIds) await promoteWaitlist(tourId);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not delete the member and their data.' });
  }
});

app.delete('/api/operations/mileage/:id', requireAuth, async (req, res) => {
  try {
    if (!pool) {
      const data = localRead();
      const account = data.mileage.find(a => a.id === req.params.id);
      if (!account) return res.status(404).json({ error: 'Mileage member not found.' });
      data.mileage = data.mileage.filter(a => a.id !== req.params.id);
      data.mileageTransactions = data.mileageTransactions.filter(tx => tx.discord_username !== account.discord_username || tx.roblox_username !== account.roblox_username);
      localWrite(data);
      return res.json({ ok: true });
    }

    const { rows } = await pool.query('SELECT * FROM mileage_accounts WHERE id=$1 LIMIT 1', [req.params.id]);
    const account = rows[0];
    if (!account) return res.status(404).json({ error: 'Mileage member not found.' });
    await pool.query('DELETE FROM mileage_transactions WHERE discord_username=$1 AND roblox_username=$2', [account.discord_username, account.roblox_username]);
    await pool.query('DELETE FROM mileage_accounts WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not delete mileage member.' });
  }
});

app.post('/api/mileage/redeem', async (req, res) => {
  const discord = safeText(req.body.discordUsername, 100);
  const roblox = safeText(req.body.robloxUsername, 100);
  const tier = safeText(req.body.tier, 30);
  if (!BENEFITS[tier]) return res.status(400).json({ error: 'Invalid membership tier.' });
  try {
    const account = await ensureMileageAccount(discord, roblox);
    const cost = BENEFITS[tier].cost;
    if (account.tier === 'Executive') return res.status(400).json({ error: 'Your account already has Executive membership.' });
    if (account.tier === 'Priority' && tier === 'Priority') return res.status(400).json({ error: 'Your account already has Priority membership.' });
    if (Number(account.miles) < cost) return res.status(400).json({ error: `You need ${cost.toLocaleString()} miles to redeem ${tier}. You currently have ${Number(account.miles).toLocaleString()}.` });

    const remaining = Number(account.miles) - cost;
    let updated;
    if (!pool) {
      const data = localRead();
      const stored = data.mileage.find(a => a.id === account.id);
      stored.miles = remaining;
      stored.tier = tier;
      data.mileageTransactions.unshift({
        id: id('mile_tx'),
        discord_username: stored.discord_username,
        roblox_username: stored.roblox_username,
        amount: -cost,
        kind: 'redemption',
        description: `${tier} membership redeemed`,
        booking_id: null,
        created_at: new Date().toISOString()
      });
      localWrite(data);
      updated = stored;
    } else {
      await pool.query('UPDATE mileage_accounts SET miles=$1,tier=$2,updated_at=NOW() WHERE id=$3', [remaining,tier,account.id]);
      await pool.query(
        `INSERT INTO mileage_transactions (id,discord_username,roblox_username,amount,kind,description)
         VALUES ($1,$2,$3,$4,'redemption',$5)`,
        [id('mile_tx'), account.discord_username, account.roblox_username, -cost, `${tier} membership redeemed`]
      );
      updated = await getMileageAccount(discord, roblox);
    }
    res.json({ ok: true, ...updated, cost });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not redeem membership.' });
  }
});

app.post('/api/bookings', async (req, res) => {
  const discordUsername = safeText(req.body.discordUsername, 100);
  const robloxUsername = safeText(req.body.robloxUsername, 100);
  const requestedTourId = safeText(req.body.tourId, 120);
  let tourType = safeText(req.body.tourType, 30) || 'Private';
  const requestedPassengers = Math.max(1, Math.min(99, Number(req.body.passengers) || 1));
  let date = safeText(req.body.date, 30);
  let time = safeText(req.body.time, 30);
  let timezone = safeText(req.body.timezone, 80) || DEFAULT_TIMEZONE;
  let origin = safeText(req.body.origin, 120);
  let destination = safeText(req.body.destination, 120);
  const notes = safeText(req.body.notes, 1000);

  if (!discordUsername || !robloxUsername || !date || !time || !origin || !destination) {
    return res.status(400).json({ error: 'Please complete the required booking fields.' });
  }

  try {
    let tour = null;
    if (requestedTourId) {
      tour = await getTourById(requestedTourId);
      if (!tour) return res.status(404).json({ error: 'The selected tour could not be found.' });
      if (tour.status === 'Cancelled' || tour.status === 'Completed') return res.status(400).json({ error: 'This tour is no longer available for booking.' });
      tourType = tour.type;
      date = tour.date;
      time = tour.time;
      timezone = tour.timezone || DEFAULT_TIMEZONE;
      origin = tour.origin;
      destination = tour.destination;
    }

    const account = await ensureMileageAccount(discordUsername, robloxUsername);
    const membershipTier = account.tier || 'None';
    let status = 'Pending';
    let mealService = 'Standard';

    if (tourType === 'Public') {
      if (!tour) return res.status(400).json({ error: 'Please select a scheduled public tour.' });
      const reserved = await countReservedSeats(tour.id);
      const remaining = Number(tour.capacity) - reserved;
      status = remaining >= requestedPassengers ? 'Pending' : 'Waitlisted';
    } else {
      if (membershipTier === 'Priority' || membershipTier === 'Executive') {
        status = 'Pending';
      } else {
        status = 'Waitlisted';
      }
      if (membershipTier === 'Executive') mealService = 'Premium';
    }

    const booking = {
      id: id('booking'),
      tour_id: tour?.id || null,
      tour_type: tourType,
      discord_username: discordUsername,
      roblox_username: robloxUsername,
      passengers: requestedPassengers,
      date,
      time,
      timezone,
      origin,
      destination,
      notes,
      status,
      membership_tier: membershipTier,
      meal_service: mealService,
      confirmation_code: generateConfirmationCode(),
      checked_in: false,
      checked_in_at: null,
      miles_awarded: 0
    };

    const saved = await saveBooking(booking);
    const confirmation = bookingDiscordText(saved);
    res.status(201).json({
      ok: true,
      booking: saved,
      confirmation,
      message: status === 'Waitlisted'
        ? 'Your request has been placed on the waitlist.'
        : 'Your tour request has been submitted.'
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not submit the booking.' });
  }
});

app.get('/api/checkin', async (req, res) => {
  const code = safeText(req.query.code, 20).toUpperCase();
  const roblox = safeText(req.query.roblox, 100);
  if (!code || !roblox) return res.status(400).json({ error: 'Enter your confirmation code and Roblox username.' });
  try {
    const booking = await getBookingByCode(code);
    if (!booking) return res.status(404).json({ error: 'Booking not found. Check your confirmation code.' });
    if (normalizeIdentity(booking.roblox_username) !== normalizeIdentity(roblox)) return res.status(403).json({ error: 'The Roblox username does not match this booking.' });
    res.json({
      id: booking.id,
      confirmationCode: booking.confirmation_code,
      status: booking.status,
      checkedIn: Boolean(booking.checked_in),
      checkedInAt: booking.checked_in_at,
      tourType: booking.tour_type,
      membershipTier: booking.membership_tier,
      mealService: booking.meal_service,
      date: booking.date,
      time: booking.time,
      timezone: booking.timezone || DEFAULT_TIMEZONE,
      startTimestamp: (() => { try { return zonedDateToTimestamp(booking.date, booking.time, booking.timezone || DEFAULT_TIMEZONE); } catch { return null; } })(),
      origin: booking.origin,
      destination: booking.destination,
      passengers: booking.passengers
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not look up your check-in.' });
  }
});

async function getBookingByCode(code) {
  if (!pool) return localRead().bookings.find(b => String(b.confirmation_code).toUpperCase() === code) || null;
  const { rows } = await pool.query('SELECT * FROM bookings WHERE UPPER(confirmation_code)=UPPER($1) LIMIT 1', [code]);
  return rows[0] || null;
}

app.post('/api/checkin', async (req, res) => {
  const code = safeText(req.body.confirmationCode, 20).toUpperCase();
  const roblox = safeText(req.body.robloxUsername, 100);
  if (!code || !roblox) return res.status(400).json({ error: 'Enter your confirmation code and Roblox username.' });
  try {
    const booking = await getBookingByCode(code);
    if (!booking) return res.status(404).json({ error: 'Booking not found. Check your confirmation code.' });
    if (normalizeIdentity(booking.roblox_username) !== normalizeIdentity(roblox)) return res.status(403).json({ error: 'The Roblox username does not match this booking.' });
    if (!['Confirmed','Boarding'].includes(booking.status)) return res.status(400).json({ error: `Online check-in is available after your booking is confirmed. Current status: ${booking.status}.` });
    if (booking.checked_in) return res.json({ ok: true, alreadyCheckedIn: true, checkedInAt: booking.checked_in_at, confirmationCode: booking.confirmation_code });

    const now = new Date().toISOString();
    const updated = await updateBooking(booking.id, { checked_in: true, checked_in_at: now });
    res.json({ ok: true, checkedInAt: now, confirmationCode: updated.confirmation_code });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not complete online check-in.' });
  }
});

app.patch('/api/bookings/:id/status', requireAuth, async (req, res) => {
  const status = safeText(req.body.status, 30);
  if (!['Pending','Waitlisted','Confirmed','Declined','Boarding','Completed','Cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  try {
    const before = await getBookingById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Booking not found.' });

    if (['Confirmed','Boarding'].includes(status) && before.tour_id && ['Pending','Waitlisted','Confirmed','Boarding'].includes(before.status)) {
      const tour = await getTourById(before.tour_id);
      if (tour && tour.type === 'Public' && before.status === 'Waitlisted') {
        const reserved = await countReservedSeats(before.tour_id);
        if (reserved + Number(before.passengers || 0) > Number(tour.capacity || 0)) {
          return res.status(409).json({ error: 'This public tour is currently full. The waitlisted booking cannot be confirmed until seats become available.' });
        }
      }
    }

    const updated = await updateBooking(req.params.id, { status });
    let mileageAward = null;
    if (status === 'Completed') mileageAward = await awardMileageForBooking(updated);
    if (['Declined','Cancelled'].includes(status) && before.tour_id) await promoteWaitlist(before.tour_id);

    const finalBooking = await getBookingById(req.params.id);
    res.json({ ok: true, booking: finalBooking, mileageAward, discordText: bookingDiscordText(finalBooking) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not update booking status.' });
  }
});

app.get('/api/bookings/:id/discord', requireAuth, async (req, res) => {
  try {
    const booking = await getBookingById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });
    res.json({ ok: true, discordText: bookingDiscordText(booking) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not generate the Discord message.' });
  }
});

app.delete('/api/bookings/:id', requireAuth, async (req, res) => {
  try {
    const booking = await getBookingById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    if (!pool) {
      const data = localRead();
      data.bookings = data.bookings.filter(b => b.id !== req.params.id);
      localWrite(data);
    } else {
      await pool.query('DELETE FROM bookings WHERE id=$1', [req.params.id]);
    }

    if (booking.tour_id && ['Pending','Waitlisted','Confirmed','Boarding'].includes(booking.status)) {
      await promoteWaitlist(booking.tour_id);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not delete booking.' });
  }
});

app.get('/operations', (req, res) => res.sendFile(path.join(__dirname, 'public', 'operations.html')));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb()
  .then(() => app.listen(PORT, () => console.log(`PTFS Tour Services running on port ${PORT}`)))
  .catch(error => {
    console.error('Database initialization failed:', error);
    process.exit(1);
  });
