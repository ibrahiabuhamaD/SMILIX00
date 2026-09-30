const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const envPath = path.join(__dirname, '1.env');
require('dotenv').config({ path: fs.existsSync(envPath) ? envPath : path.join(__dirname, '.env') });
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const bcrypt = require('bcryptjs');

const app = express();
const port = Number(process.env.PORT || 3000);
const dataDirectory = path.join(__dirname, 'data');
const databasePath = process.env.DATABASE_PATH || path.join(dataDirectory, 'smilix.sqlite');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const database = new DatabaseSync(databasePath);
database.exec('PRAGMA journal_mode = WAL;');
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    age INTEGER NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'patient',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    appointment_date TEXT NOT NULL,
    appointment_time TEXT NOT NULL,
    service TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'booked',
    reminder_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_slot
    ON appointments(appointment_date, appointment_time) WHERE status = 'booked';
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const defaults = {
  clinicName: 'SMILIX',
  clinicPhone: '962782578156',
  intro: 'ابتسامتك تستحق عناية مختلفة. رعاية أسنان هادئة، دقيقة، ومصممة لك.',
  openTime: '09:00',
  closeTime: '17:00',
  slotMinutes: '30',
  services: JSON.stringify(['فحص وتنظيف', 'تبييض الأسنان', 'تقويم الأسنان', 'علاج العصب', 'زراعة الأسنان', 'تجميل الابتسامة'])
};
const getSetting = database.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = database.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
for (const [key, value] of Object.entries(defaults)) {
  if (!getSetting.get(key)) setSetting.run(key, value);
}

const initialAdminEmail = (process.env.ADMIN_EMAIL || 'ibr.jx@gmail.com').trim().toLowerCase();
const initialAdminPassword = process.env.ADMIN_PASSWORD || 'ibrjX1';
if (!database.prepare('SELECT id FROM users WHERE email = ?').get(initialAdminEmail)) {
  database.prepare('INSERT INTO users (name, age, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run('مدير SMILIX', 30, initialAdminEmail, '962782578156', bcrypt.hashSync(initialAdminPassword, 12), 'admin');
}

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const cookieName = 'smilix_session';

function createSession(userId) {
  const payload = Buffer.from(JSON.stringify({ id: userId, exp: Date.now() + 7 * 86400000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readSession(req) {
  const token = (req.headers.cookie || '').split('; ').find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (session.exp < Date.now()) return null;
    return database.prepare('SELECT id, name, age, email, phone, role FROM users WHERE id = ?').get(session.id) || null;
  } catch { return null; }
}

function requireUser(req, res, next) {
  req.user = readSession(req);
  if (!req.user) return res.status(401).json({ error: 'سجّل الدخول للمتابعة.' });
  next();
}

function requireAdmin(req, res, next) {
  req.user = readSession(req);
  if (!req.user) return res.status(401).json({ error: 'سجّل الدخول للمتابعة.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'هذه الصفحة مخصصة للإدارة.' });
  next();
}

function clinicSettings() {
  const values = Object.fromEntries(database.prepare('SELECT key, value FROM settings').all().map(({ key, value }) => [key, value]));
  return { ...values, services: JSON.parse(values.services || '[]'), slotMinutes: Number(values.slotMinutes) };
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  const parsed = new Date(`${date}T12:00:00+03:00`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}

function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `962${digits.slice(1)}`;
  else if (digits.length === 9 && digits.startsWith('7')) digits = `962${digits}`;
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

function slotOptions(date) {
  if (!validDate(date)) return [];
  const weekday = new Date(`${date}T12:00:00+03:00`).getUTCDay();
  if (weekday === 5) return [];
  const settings = clinicSettings();
  const [openHour, openMinute] = settings.openTime.split(':').map(Number);
  const [closeHour, closeMinute] = settings.closeTime.split(':').map(Number);
  const start = openHour * 60 + openMinute;
  const end = closeHour * 60 + closeMinute;
  const interval = Math.max(15, Math.min(120, settings.slotMinutes || 30));
  const nowInJordan = Date.now() + 3 * 60 * 60 * 1000;
  const todayInJordan = new Date(nowInJordan).toISOString().slice(0, 10);
  const occupied = new Set(database.prepare("SELECT appointment_time FROM appointments WHERE appointment_date = ? AND status = 'booked'").all(date).map((row) => row.appointment_time));
  const times = [];
  for (let minute = start; minute + interval <= end; minute += interval) {
    const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    const appointmentTimestamp = Date.parse(`${date}T${time}:00+03:00`);
    if (date > todayInJordan || appointmentTimestamp > Date.now()) times.push({ time, booked: occupied.has(time) });
  }
  return times;
}

function availableTimes(date) {
  return slotOptions(date).filter((slot) => !slot.booked).map((slot) => slot.time);
}

async function sendWhatsAppTemplate(recipient, templateName, parameters) {
  const { WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID } = process.env;
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !templateName) return false;
  const version = process.env.WHATSAPP_GRAPH_VERSION || 'v22.0';
  const response = await fetch(`https://graph.facebook.com/${version}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: recipient.replace(/\D/g, ''),
      type: 'template',
      template: { name: templateName, language: { code: 'ar' }, components: [{ type: 'body', parameters: parameters.map((text) => ({ type: 'text', text })) }] }
    })
  });
  if (!response.ok) console.error('WhatsApp API error:', await response.text());
  return response.ok;
}

function sendBookingNotice(appointment, user) {
  const recipient = process.env.WHATSAPP_BUSINESS_RECIPIENT || clinicSettings().clinicPhone;
  return sendWhatsAppTemplate(recipient, process.env.WHATSAPP_BOOKING_TEMPLATE, [user.name, appointment.appointment_date, appointment.appointment_time, appointment.service, user.phone]);
}

app.get('/api/settings', (_req, res) => res.json(clinicSettings()));

app.get('/api/slots', (req, res) => {
  if (!validDate(req.query.date)) return res.status(400).json({ error: 'التاريخ غير صالح.' });
  const slots = slotOptions(req.query.date);
  res.json({ slots, times: slots.filter((slot) => !slot.booked).map((slot) => slot.time) });
});

app.get('/api/me', (req, res) => res.json({ user: readSession(req) }));

app.post('/api/register', (req, res) => {
  const { name, age, email, phone, password } = req.body || {};
  const normalizedPhone = normalizePhone(phone);
  if (!name?.trim() || !Number.isInteger(Number(age)) || Number(age) < 1 || Number(age) > 120 || !/^\S+@\S+\.\S+$/.test(email || '') || !normalizedPhone || (password || '').length < 8) {
    return res.status(400).json({ error: 'تحقق من البيانات. كلمة المرور يجب ألا تقل عن 8 أحرف.' });
  }
  try {
    const result = database.prepare('INSERT INTO users (name, age, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(name.trim(), Number(age), email.trim().toLowerCase(), normalizedPhone, bcrypt.hashSync(password, 12));
    res.cookie(cookieName, createSession(result.lastInsertRowid), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400000, path: '/' });
    res.status(201).json({ user: database.prepare('SELECT id, name, age, email, phone, role FROM users WHERE id = ?').get(result.lastInsertRowid) });
  } catch (error) {
    if (String(error.code).includes('CONSTRAINT_UNIQUE')) return res.status(409).json({ error: 'هذا البريد مسجل مسبقاً.' });
    throw error;
  }
});

app.post('/api/login', (req, res) => {
  const user = database.prepare('SELECT id, name, age, email, phone, role, password_hash FROM users WHERE email = ? COLLATE NOCASE').get((req.body?.email || '').trim());
  if (!user || !bcrypt.compareSync(req.body?.password || '', user.password_hash)) return res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' });
  res.cookie(cookieName, createSession(user.id), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400000, path: '/' });
  const { password_hash, ...safeUser } = user;
  res.json({ user: safeUser });
});

app.post('/api/logout', (_req, res) => res.clearCookie(cookieName, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' }).json({ ok: true }));

app.post('/api/appointments', requireUser, async (req, res) => {
  const { date, time, service } = req.body || {};
  const settings = clinicSettings();
  if (!validDate(date) || !availableTimes(date).includes(time) || !settings.services.includes(service)) return res.status(400).json({ error: 'هذا الموعد غير متاح. اختر وقتاً آخر.' });
  try {
    const result = database.prepare('INSERT INTO appointments (user_id, appointment_date, appointment_time, service) VALUES (?, ?, ?, ?)')
      .run(req.user.id, date, time, service);
    const appointment = { id: result.lastInsertRowid, appointment_date: date, appointment_time: time, service };
    const whatsappSent = await sendBookingNotice(appointment, req.user).catch((error) => { console.error('WhatsApp notification failed:', error.message); return false; });
    res.status(201).json({ appointment, whatsappSent });
  } catch (error) {
    if (String(error.code).includes('CONSTRAINT_UNIQUE')) return res.status(409).json({ error: 'سبق حجز هذا الوقت. اختر موعداً آخر.' });
    throw error;
  }
});

app.get('/api/appointments/mine', requireUser, (req, res) => {
  const appointments = database.prepare('SELECT id, appointment_date AS date, appointment_time AS time, service, status FROM appointments WHERE user_id = ? ORDER BY appointment_date, appointment_time').all(req.user.id);
  res.json({ appointments });
});

app.get('/api/admin/dashboard', requireAdmin, (_req, res) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const summary = {
    today: database.prepare("SELECT COUNT(*) AS total FROM appointments WHERE appointment_date = ? AND status = 'booked'").get(today).total,
    upcoming: database.prepare("SELECT COUNT(*) AS total FROM appointments WHERE appointment_date >= ? AND status = 'booked'").get(today).total,
    patients: database.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'patient'").get().total
  };
  const appointments = database.prepare(`SELECT a.id, a.appointment_date AS date, a.appointment_time AS time, a.service, a.status, u.name, u.phone, u.email
    FROM appointments a JOIN users u ON u.id = a.user_id ORDER BY a.appointment_date DESC, a.appointment_time DESC LIMIT 100`).all();
  res.json({ summary, appointments, settings: clinicSettings() });
});

app.patch('/api/admin/appointments/:id', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!['booked', 'completed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'حالة الموعد غير صالحة.' });
  try {
    const result = database.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, Number(req.params.id));
    if (!result.changes) return res.status(404).json({ error: 'الموعد غير موجود.' });
    res.json({ ok: true });
  } catch (error) {
    if (String(error.code).includes('CONSTRAINT_UNIQUE')) return res.status(409).json({ error: 'لا يمكن إعادة تفعيل الموعد؛ هذا الوقت حُجز لمريض آخر.' });
    throw error;
  }
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const { clinicName, clinicPhone, intro, openTime, closeTime, slotMinutes, services } = req.body || {};
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!clinicName?.trim() || !/^\d{8,15}$/.test((clinicPhone || '').replace(/\D/g, '')) || !timePattern.test(openTime || '') || !timePattern.test(closeTime || '') || Number(slotMinutes) < 15 || Number(slotMinutes) > 120 || !Array.isArray(services) || !services.length || services.length > 12) {
    return res.status(400).json({ error: 'راجع الاسم ورقم الهاتف وساعات العمل والخدمات.' });
  }
  if (openTime >= closeTime) return res.status(400).json({ error: 'وقت الإغلاق يجب أن يكون بعد وقت الافتتاح.' });
  database.exec('BEGIN IMMEDIATE');
  try {
    setSetting.run('clinicName', clinicName.trim());
    setSetting.run('clinicPhone', clinicPhone.replace(/\D/g, ''));
    setSetting.run('intro', (intro || '').trim().slice(0, 240));
    setSetting.run('openTime', openTime);
    setSetting.run('closeTime', closeTime);
    setSetting.run('slotMinutes', String(Number(slotMinutes)));
    setSetting.run('services', JSON.stringify(services.map((service) => String(service).trim()).filter(Boolean)));
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  res.json({ settings: clinicSettings() });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'حدث خطأ غير متوقع. حاول مجدداً.' });
});

async function sendDueReminders() {
  const now = Date.now();
  const due = database.prepare("SELECT a.id, a.appointment_date, a.appointment_time, a.service, u.name, u.phone FROM appointments a JOIN users u ON u.id = a.user_id WHERE a.status = 'booked' AND a.reminder_sent = 0 AND a.appointment_date >= date('now', '-1 day')").all();
  for (const appointment of due) {
    const appointmentTime = Date.parse(`${appointment.appointment_date}T${appointment.appointment_time}:00+03:00`);
    if (appointmentTime > now && appointmentTime <= now + 60 * 60 * 1000) {
      const sent = await sendWhatsAppTemplate(appointment.phone, process.env.WHATSAPP_REMINDER_TEMPLATE, [appointment.name, appointment.appointment_date, appointment.appointment_time, appointment.service]).catch((error) => { console.error('WhatsApp reminder failed:', error.message); return false; });
      if (sent) database.prepare('UPDATE appointments SET reminder_sent = 1 WHERE id = ?').run(appointment.id);
    }
  }
}

app.listen(port, () => {
  console.log(`SMILIX is running at http://localhost:${port}`);
  sendDueReminders().catch(console.error);
  setInterval(() => sendDueReminders().catch(console.error), 60 * 1000);
});

app.patch('/api/admin/password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = database.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(currentPassword || '', user.password_hash)) return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة.' });
  if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: 'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف.' });
  database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 12), req.user.id);
  res.json({ ok: true });
});