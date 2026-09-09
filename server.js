'use strict';
// Arranque local. En Vercel se usa api/index.js.
const app = require('./app');
const { nowInTz, TZ } = require('./lib/time');
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  const ahora = nowInTz();
  console.log(`Asistencia en http://localhost:${PORT}  (zona horaria ${TZ}, ahora ${ahora.diaNombre} ${ahora.fecha} ${ahora.hora})`);
});
