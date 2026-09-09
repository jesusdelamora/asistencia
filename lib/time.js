'use strict';

const TZ = process.env.APP_TZ || 'America/Mexico_City';
const DIAS = { 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes', 6: 'Sábado', 7: 'Domingo' };
const WEEKDAY_MAP = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

// Devuelve la fecha/hora actual en la zona horaria de la app.
// APP_FAKE_NOW (ISO) permite simular otro momento para pruebas.
function nowInTz(date) {
  const d = date || (process.env.APP_FAKE_NOW ? new Date(process.env.APP_FAKE_NOW) : new Date());
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  const hour = String(Number(p.hour) % 24).padStart(2, '0');
  return {
    fecha: `${p.year}-${p.month}-${p.day}`,
    hora: `${hour}:${p.minute}`,
    horaCompleta: `${hour}:${p.minute}:${p.second}`,
    dia: WEEKDAY_MAP[p.weekday],
    diaNombre: DIAS[WEEKDAY_MAP[p.weekday]],
    tz: TZ,
  };
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function isValidHora(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

module.exports = { nowInTz, toMinutes, isValidHora, DIAS, TZ };
