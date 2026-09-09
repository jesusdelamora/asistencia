'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createClient } = require('@libsql/client');

// En Vercel la integración de Turso crea <PREFIJO>_URL (o _DATABASE_URL) y <PREFIJO>_AUTH_TOKEN.
// Se detectan con cualquier prefijo. En local sin variables: archivo SQLite.
function credencialesTurso() {
  const env = process.env;
  const nombreUrl = ['TURSO_DATABASE_URL', 'TURSO_URL', 'STORAGE_URL'].find(k => env[k])
    || Object.keys(env).find(k => /_URL$/.test(k) && /^libsql:\/\//.test(env[k] || ''));
  if (!nombreUrl) return null;
  const prefijo = nombreUrl.replace(/_(DATABASE_)?URL$/, '');
  const authToken = env[prefijo + '_AUTH_TOKEN'] || env[prefijo + '_TOKEN'] || env.TURSO_AUTH_TOKEN;
  return { url: env[nombreUrl], authToken };
}
function buildClient() {
  const turso = credencialesTurso();
  if (turso) return createClient(turso);
  if (process.env.VERCEL) throw new Error('No se encontró la URL de Turso. Conecta la integración de Turso al proyecto en Vercel (Storage).');
  const file = path.join(__dirname, 'data', 'asistencia.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return createClient({ url: `file:${file}` });
}

const client = buildClient();

async function all(sql, args = []) { return (await client.execute({ sql, args })).rows; }
async function one(sql, args = []) { return (await all(sql, args))[0]; }
async function run(sql, args = []) {
  const r = await client.execute({ sql, args });
  return { changes: r.rowsAffected, lastId: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid) };
}
async function batch(stmts) { return client.batch(stmts.map(s => (typeof s === 'string' ? s : { sql: s.sql, args: s.args || [] })), 'write'); }

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS materias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    grupo TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#e5e7eb',
    activa INTEGER NOT NULL DEFAULT 1,
    creada_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS horarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
    dia INTEGER NOT NULL CHECK (dia BETWEEN 1 AND 7),
    hora_inicio TEXT NOT NULL,
    hora_fin TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS alumnos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    matricula TEXT NOT NULL UNIQUE,
    nombre TEXT NOT NULL,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS inscripciones (
    alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
    materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
    PRIMARY KEY (alumno_id, materia_id)
  )`,
  `CREATE TABLE IF NOT EXISTS asistencias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
    materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
    horario_id INTEGER REFERENCES horarios(id) ON DELETE SET NULL,
    fecha TEXT NOT NULL,
    hora TEXT NOT NULL,
    origen TEXT NOT NULL DEFAULT 'checkin',
    UNIQUE (alumno_id, materia_id, fecha)
  )`,
  `CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_asistencias_materia_fecha ON asistencias(materia_id, fecha)`,
];

async function getAjuste(clave, porDefecto) {
  const row = await one('SELECT valor FROM ajustes WHERE clave = ?', [clave]);
  return row ? row.valor : porDefecto;
}
async function setAjuste(clave, valor) {
  await run('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor', [clave, String(valor)]);
}

// Carga inicial desde data/seed.json si la base está vacía.
async function seedIfEmpty() {
  const { n } = await one('SELECT COUNT(*) AS n FROM materias');
  if (Number(n) > 0) return;
  const seedPath = path.join(__dirname, 'data', 'seed.json');
  if (!fs.existsSync(seedPath)) return;
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  const materiaIds = {};
  for (const m of seed.materias) {
    const r = await run('INSERT INTO materias (nombre, grupo, color) VALUES (?, ?, ?)', [m.nombre, m.grupo || '', m.color || '#e5e7eb']);
    materiaIds[m.nombre] = r.lastId;
    for (const h of m.horarios || []) {
      await run('INSERT INTO horarios (materia_id, dia, hora_inicio, hora_fin) VALUES (?, ?, ?, ?)', [r.lastId, h.dia, h.inicio, h.fin]);
    }
  }
  const stmts = [];
  for (const a of seed.alumnos) {
    stmts.push({ sql: 'INSERT OR IGNORE INTO alumnos (matricula, nombre) VALUES (?, ?)', args: [a.matricula, a.nombre] });
    if (a.materia && materiaIds[a.materia]) {
      stmts.push({ sql: 'INSERT OR IGNORE INTO inscripciones (alumno_id, materia_id) SELECT id, ? FROM alumnos WHERE matricula = ?', args: [materiaIds[a.materia], a.matricula] });
    }
  }
  stmts.push({ sql: "INSERT OR IGNORE INTO ajustes (clave, valor) VALUES ('tolerancia_antes', '0')" });
  stmts.push({ sql: "INSERT OR IGNORE INTO ajustes (clave, valor) VALUES ('tolerancia_despues', '0')" });
  await batch(stmts);
  console.log(`Base inicial cargada: ${seed.materias.length} materias, ${seed.alumnos.length} alumnos.`);
}

let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await client.execute('PRAGMA foreign_keys = ON');
      for (const sql of SCHEMA) await client.execute(sql);
      await seedIfEmpty();
    })().catch(e => { readyPromise = null; throw e; });
  }
  return readyPromise;
}

module.exports = { client, all, one, run, batch, ready, getAjuste, setAjuste };
