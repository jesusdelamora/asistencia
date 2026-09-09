'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const db = require('./db');
const { nowInTz, toMinutes, isValidHora, DIAS, TZ } = require('./lib/time');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('asistencia:' + ADMIN_PASSWORD).digest('hex');
if (!process.env.ADMIN_PASSWORD) {
  console.warn('AVISO: ADMIN_PASSWORD no está definida; se usa "admin". Cámbiala antes de publicar.');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Garantiza esquema y datos iniciales antes de cualquier ruta de API.
app.use('/api', (req, res, next) => { db.ready().then(() => next(), next); });

// Envoltorio para handlers async.
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Autenticación del panel ----------
const adminToken = () => crypto.createHmac('sha256', SESSION_SECRET).update('admin').digest('hex');
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
const isAdmin = req => safeEqual(parseCookies(req).admin_token || '', adminToken());
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'No autorizado' });
}

app.post('/api/admin/login', (req, res) => {
  if (!safeEqual(req.body?.password || '', ADMIN_PASSWORD)) return res.status(401).json({ error: 'Contraseña incorrecta' });
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `admin_token=${adminToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req) }));

// ---------- Check-in de alumnos ----------
async function clasesActivas(alumnoId, ahora) {
  const antes = Number(await db.getAjuste('tolerancia_antes', '0')) || 0;
  const despues = Number(await db.getAjuste('tolerancia_despues', '0')) || 0;
  const minutos = toMinutes(ahora.hora);
  const rows = await db.all(`
    SELECT h.id AS horario_id, h.hora_inicio, h.hora_fin, m.id AS materia_id, m.nombre, m.grupo
    FROM horarios h
    JOIN materias m ON m.id = h.materia_id
    JOIN inscripciones i ON i.materia_id = m.id
    WHERE i.alumno_id = ? AND h.dia = ? AND m.activa = 1
    ORDER BY h.hora_inicio`, [alumnoId, ahora.dia]);
  return rows.filter(r => minutos >= toMinutes(r.hora_inicio) - antes && minutos <= toMinutes(r.hora_fin) + despues);
}

async function proximaClase(alumnoId, ahora) {
  const rows = await db.all(`
    SELECT h.dia, h.hora_inicio, h.hora_fin, m.nombre, m.grupo
    FROM horarios h
    JOIN materias m ON m.id = h.materia_id
    JOIN inscripciones i ON i.materia_id = m.id
    WHERE i.alumno_id = ? AND m.activa = 1`, [alumnoId]);
  if (!rows.length) return null;
  const nowMin = ahora.dia * 1440 + toMinutes(ahora.hora);
  let best = null;
  for (const r of rows) {
    let start = Number(r.dia) * 1440 + toMinutes(r.hora_inicio);
    if (start < nowMin) start += 7 * 1440;
    if (!best || start < best.start) best = { start, ...r };
  }
  return { materia: best.nombre, grupo: best.grupo, dia: DIAS[best.dia], hora_inicio: best.hora_inicio, hora_fin: best.hora_fin };
}

app.get('/api/estado', (req, res) => {
  const ahora = nowInTz();
  res.json({ fecha: ahora.fecha, hora: ahora.hora, dia: ahora.diaNombre, tz: TZ });
});

app.post('/api/checkin', h(async (req, res) => {
  const matricula = String(req.body?.matricula || '').trim();
  if (!matricula) return res.status(400).json({ error: 'Escribe tu matrícula.' });

  const alumno = await db.one('SELECT id, matricula, nombre FROM alumnos WHERE matricula = ?', [matricula]);
  if (!alumno) return res.status(404).json({ error: 'Matrícula no registrada. Verifica el número o avisa a tu profesor.' });

  const ahora = nowInTz();
  const activas = await clasesActivas(alumno.id, ahora);
  if (!activas.length) {
    const prox = await proximaClase(alumno.id, ahora);
    const detalle = prox
      ? `Tu próxima clase es ${prox.materia} (${prox.grupo}) el ${prox.dia} de ${prox.hora_inicio} a ${prox.hora_fin}.`
      : 'No estás inscrito en ninguna materia con horario.';
    return res.status(403).json({
      error: `Hola ${alumno.nombre}. Ahora (${ahora.diaNombre} ${ahora.hora}) no tienes clase; el check-in solo se permite dentro del horario.`,
      detalle,
      alumno: { nombre: alumno.nombre, matricula: alumno.matricula },
    });
  }

  const clase = activas[0];
  const existente = await db.one('SELECT hora FROM asistencias WHERE alumno_id = ? AND materia_id = ? AND fecha = ?',
    [alumno.id, clase.materia_id, ahora.fecha]);
  if (existente) {
    return res.json({
      ok: true, repetido: true,
      mensaje: `Ya registraste tu asistencia hoy a las ${existente.hora}.`,
      alumno: { nombre: alumno.nombre, matricula: alumno.matricula },
      materia: { nombre: clase.nombre, grupo: clase.grupo },
      fecha: ahora.fecha, hora: existente.hora,
    });
  }

  await db.run('INSERT INTO asistencias (alumno_id, materia_id, horario_id, fecha, hora, origen) VALUES (?, ?, ?, ?, ?, ?)',
    [alumno.id, clase.materia_id, clase.horario_id, ahora.fecha, ahora.hora, 'checkin']);
  const { n } = await db.one('SELECT COUNT(*) AS n FROM asistencias WHERE alumno_id = ? AND materia_id = ?', [alumno.id, clase.materia_id]);

  res.json({
    ok: true,
    mensaje: `Asistencia registrada. ¡Bienvenido, ${alumno.nombre}!`,
    alumno: { nombre: alumno.nombre, matricula: alumno.matricula },
    materia: { nombre: clase.nombre, grupo: clase.grupo },
    fecha: ahora.fecha, hora: ahora.hora, totalAsistencias: Number(n),
  });
}));

// ---------- API de administración ----------
const admin = express.Router();
admin.use(requireAdmin);

admin.get('/resumen', h(async (req, res) => {
  const ahora = nowInTz();
  res.json({
    ahora: { fecha: ahora.fecha, hora: ahora.hora, dia: ahora.diaNombre, tz: TZ },
    materias: Number((await db.one('SELECT COUNT(*) AS n FROM materias')).n),
    alumnos: Number((await db.one('SELECT COUNT(*) AS n FROM alumnos')).n),
    asistenciasHoy: Number((await db.one('SELECT COUNT(*) AS n FROM asistencias WHERE fecha = ?', [ahora.fecha])).n),
    ajustes: {
      tolerancia_antes: Number(await db.getAjuste('tolerancia_antes', '0')),
      tolerancia_despues: Number(await db.getAjuste('tolerancia_despues', '0')),
    },
  });
}));

admin.put('/ajustes', h(async (req, res) => {
  const { tolerancia_antes, tolerancia_despues } = req.body || {};
  for (const [k, v] of Object.entries({ tolerancia_antes, tolerancia_despues })) {
    if (v === undefined) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 180) return res.status(400).json({ error: `${k} debe ser un entero entre 0 y 180.` });
    await db.setAjuste(k, n);
  }
  res.json({ ok: true });
}));

// Materias
admin.get('/materias', h(async (req, res) => {
  const materias = await db.all(`
    SELECT m.*, (SELECT COUNT(*) FROM inscripciones i WHERE i.materia_id = m.id) AS alumnos
    FROM materias m ORDER BY m.activa DESC, m.nombre`);
  const horarios = await db.all('SELECT * FROM horarios ORDER BY dia, hora_inicio');
  for (const m of materias) { m.alumnos = Number(m.alumnos); m.horarios = horarios.filter(x => x.materia_id === m.id); }
  res.json(materias);
}));
admin.post('/materias', h(async (req, res) => {
  const nombre = String(req.body?.nombre || '').trim();
  const grupo = String(req.body?.grupo || '').trim();
  const color = String(req.body?.color || '#e5e7eb');
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  const r = await db.run('INSERT INTO materias (nombre, grupo, color) VALUES (?, ?, ?)', [nombre, grupo, color]);
  res.json({ id: r.lastId });
}));
admin.put('/materias/:id', h(async (req, res) => {
  const m = await db.one('SELECT * FROM materias WHERE id = ?', [req.params.id]);
  if (!m) return res.status(404).json({ error: 'Materia no encontrada.' });
  const nombre = req.body?.nombre !== undefined ? String(req.body.nombre).trim() : m.nombre;
  const grupo = req.body?.grupo !== undefined ? String(req.body.grupo).trim() : m.grupo;
  const color = req.body?.color !== undefined ? String(req.body.color) : m.color;
  const activa = req.body?.activa !== undefined ? (req.body.activa ? 1 : 0) : m.activa;
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  await db.run('UPDATE materias SET nombre = ?, grupo = ?, color = ?, activa = ? WHERE id = ?', [nombre, grupo, color, activa, m.id]);
  res.json({ ok: true });
}));
admin.delete('/materias/:id', h(async (req, res) => {
  const r = await db.run('DELETE FROM materias WHERE id = ?', [req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Materia no encontrada.' });
  res.json({ ok: true });
}));

// Horarios
admin.post('/materias/:id/horarios', h(async (req, res) => {
  const m = await db.one('SELECT id FROM materias WHERE id = ?', [req.params.id]);
  if (!m) return res.status(404).json({ error: 'Materia no encontrada.' });
  const dia = Number(req.body?.dia);
  const { hora_inicio, hora_fin } = req.body || {};
  if (!Number.isInteger(dia) || dia < 1 || dia > 7) return res.status(400).json({ error: 'Día inválido.' });
  if (!isValidHora(hora_inicio) || !isValidHora(hora_fin)) return res.status(400).json({ error: 'Hora inválida (usa HH:MM).' });
  if (toMinutes(hora_fin) <= toMinutes(hora_inicio)) return res.status(400).json({ error: 'La hora de fin debe ser posterior a la de inicio.' });
  const r = await db.run('INSERT INTO horarios (materia_id, dia, hora_inicio, hora_fin) VALUES (?, ?, ?, ?)', [m.id, dia, hora_inicio, hora_fin]);
  res.json({ id: r.lastId });
}));
admin.delete('/horarios/:id', h(async (req, res) => {
  const r = await db.run('DELETE FROM horarios WHERE id = ?', [req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Horario no encontrado.' });
  res.json({ ok: true });
}));

// Alumnos
admin.get('/alumnos', h(async (req, res) => {
  const materiaId = req.query.materia ? Number(req.query.materia) : null;
  const q = String(req.query.q || '').trim().toLowerCase();
  let alumnos = await db.all('SELECT * FROM alumnos ORDER BY nombre');
  const inscripciones = await db.all('SELECT alumno_id, materia_id FROM inscripciones');
  for (const a of alumnos) a.materias = inscripciones.filter(i => i.alumno_id === a.id).map(i => Number(i.materia_id));
  if (materiaId) alumnos = alumnos.filter(a => a.materias.includes(materiaId));
  if (q) alumnos = alumnos.filter(a => a.nombre.toLowerCase().includes(q) || a.matricula.toLowerCase().includes(q));
  res.json(alumnos);
}));
admin.post('/alumnos', h(async (req, res) => {
  const matricula = String(req.body?.matricula || '').trim();
  const nombre = String(req.body?.nombre || '').trim();
  const materias = Array.isArray(req.body?.materias) ? req.body.materias.map(Number) : [];
  if (!matricula || !nombre) return res.status(400).json({ error: 'Matrícula y nombre son obligatorios.' });
  if (await db.one('SELECT 1 FROM alumnos WHERE matricula = ?', [matricula])) return res.status(409).json({ error: 'Esa matrícula ya existe.' });
  const r = await db.run('INSERT INTO alumnos (matricula, nombre) VALUES (?, ?)', [matricula, nombre]);
  if (materias.length) await db.batch(materias.map(mid => ({ sql: 'INSERT OR IGNORE INTO inscripciones (alumno_id, materia_id) VALUES (?, ?)', args: [r.lastId, mid] })));
  res.json({ id: r.lastId });
}));
admin.put('/alumnos/:id', h(async (req, res) => {
  const a = await db.one('SELECT * FROM alumnos WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Alumno no encontrado.' });
  const matricula = req.body?.matricula !== undefined ? String(req.body.matricula).trim() : a.matricula;
  const nombre = req.body?.nombre !== undefined ? String(req.body.nombre).trim() : a.nombre;
  if (!matricula || !nombre) return res.status(400).json({ error: 'Matrícula y nombre son obligatorios.' });
  if (await db.one('SELECT id FROM alumnos WHERE matricula = ? AND id != ?', [matricula, a.id])) return res.status(409).json({ error: 'Esa matrícula ya la tiene otro alumno.' });
  await db.run('UPDATE alumnos SET matricula = ?, nombre = ? WHERE id = ?', [matricula, nombre, a.id]);
  if (Array.isArray(req.body?.materias)) {
    await db.batch([
      { sql: 'DELETE FROM inscripciones WHERE alumno_id = ?', args: [a.id] },
      ...req.body.materias.map(mid => ({ sql: 'INSERT OR IGNORE INTO inscripciones (alumno_id, materia_id) VALUES (?, ?)', args: [a.id, Number(mid)] })),
    ]);
  }
  res.json({ ok: true });
}));
admin.delete('/alumnos/:id', h(async (req, res) => {
  const r = await db.run('DELETE FROM alumnos WHERE id = ?', [req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Alumno no encontrado.' });
  res.json({ ok: true });
}));

// Importación masiva: una línea por alumno "matricula, nombre" (separador: coma, tab o punto y coma).
admin.post('/alumnos/importar', h(async (req, res) => {
  const texto = String(req.body?.texto || '');
  const materiaId = req.body?.materia_id ? Number(req.body.materia_id) : null;
  if (materiaId && !(await db.one('SELECT 1 FROM materias WHERE id = ?', [materiaId]))) return res.status(404).json({ error: 'Materia no encontrada.' });
  const filas = [], omitidos = [];
  for (const raw of texto.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(?:\d+\s*[.)]?\s*[\t;,]\s*)?([0-9A-Za-z-]+)\s*[\t;,]\s*(.+)$/) || line.match(/^([0-9A-Za-z-]+)\s{2,}(.+)$/);
    if (!m || /^mat/i.test(m[1])) { omitidos.push(line); continue; }
    filas.push({ matricula: m[1], nombre: m[2].replace(/\s+,\s*/g, ', ').replace(/\s+/g, ' ').trim() });
  }
  if (!filas.length) return res.status(400).json({ error: 'No se reconoció ninguna línea con formato "matrícula, nombre".', omitidos });
  const antes = Number((await db.one('SELECT COUNT(*) AS n FROM alumnos')).n);
  const antesIns = materiaId ? Number((await db.one('SELECT COUNT(*) AS n FROM inscripciones WHERE materia_id = ?', [materiaId])).n) : 0;
  const stmts = [];
  for (const f of filas) {
    stmts.push({ sql: 'INSERT OR IGNORE INTO alumnos (matricula, nombre) VALUES (?, ?)', args: [f.matricula, f.nombre] });
    if (materiaId) stmts.push({ sql: 'INSERT OR IGNORE INTO inscripciones (alumno_id, materia_id) SELECT id, ? FROM alumnos WHERE matricula = ?', args: [materiaId, f.matricula] });
  }
  await db.batch(stmts);
  const despues = Number((await db.one('SELECT COUNT(*) AS n FROM alumnos')).n);
  const despuesIns = materiaId ? Number((await db.one('SELECT COUNT(*) AS n FROM inscripciones WHERE materia_id = ?', [materiaId])).n) : 0;
  res.json({ leidos: filas.length, nuevos: despues - antes, inscritos: despuesIns - antesIns, omitidos });
}));

// Asistencias
async function reporte(materiaId, desde, hasta) {
  const alumnos = await db.all(`
    SELECT a.id, a.matricula, a.nombre FROM alumnos a
    JOIN inscripciones i ON i.alumno_id = a.id WHERE i.materia_id = ? ORDER BY a.nombre`, [materiaId]);
  const registros = await db.all(`
    SELECT alumno_id, fecha, hora, origen FROM asistencias
    WHERE materia_id = ? AND fecha BETWEEN ? AND ? ORDER BY fecha`, [materiaId, desde || '0000-01-01', hasta || '9999-12-31']);
  const fechas = [...new Set(registros.map(r => r.fecha))].sort();
  return { alumnos, fechas, registros };
}
admin.get('/asistencias', h(async (req, res) => {
  const materiaId = Number(req.query.materia);
  if (!materiaId) return res.status(400).json({ error: 'Indica la materia.' });
  res.json(await reporte(materiaId, req.query.desde, req.query.hasta));
}));
admin.post('/asistencias', h(async (req, res) => {
  const { alumno_id, materia_id, fecha } = req.body || {};
  if (!alumno_id || !materia_id || !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) return res.status(400).json({ error: 'Datos incompletos.' });
  await db.run(`INSERT INTO asistencias (alumno_id, materia_id, fecha, hora, origen) VALUES (?, ?, ?, ?, 'manual')
                ON CONFLICT(alumno_id, materia_id, fecha) DO NOTHING`, [alumno_id, materia_id, fecha, nowInTz().hora]);
  res.json({ ok: true });
}));
admin.delete('/asistencias', h(async (req, res) => {
  const { alumno_id, materia_id, fecha } = req.body || {};
  await db.run('DELETE FROM asistencias WHERE alumno_id = ? AND materia_id = ? AND fecha = ?', [alumno_id, materia_id, fecha]);
  res.json({ ok: true });
}));
admin.get('/asistencias/csv', h(async (req, res) => {
  const materiaId = Number(req.query.materia);
  const m = await db.one('SELECT * FROM materias WHERE id = ?', [materiaId]);
  if (!m) return res.status(404).json({ error: 'Materia no encontrada.' });
  const { alumnos, fechas, registros } = await reporte(materiaId, req.query.desde, req.query.hasta);
  const esc = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [['Matrícula', 'Nombre', ...fechas, 'Total', 'Porcentaje'].map(esc).join(',')];
  for (const a of alumnos) {
    const row = fechas.map(f => { const r = registros.find(x => x.alumno_id === a.id && x.fecha === f); return r ? r.hora : ''; });
    const total = row.filter(Boolean).length;
    const pct = fechas.length ? Math.round(total * 100 / fechas.length) : 0;
    lines.push([a.matricula, a.nombre, ...row, total, `${pct}%`].map(esc).join(','));
  }
  const nombre = `asistencia-${m.nombre}-${m.grupo}`.replace(/[^\wáéíóúñÁÉÍÓÚÑ-]+/g, '_') + '.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send('﻿' + lines.join('\n'));
}));

app.use('/api/admin', admin);
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

module.exports = app;
