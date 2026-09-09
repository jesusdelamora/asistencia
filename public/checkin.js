(() => {
  const $ = s => document.querySelector(s);
  const form = $('#form'), input = $('#matricula'), btn = $('#btn'), out = $('#resultado');
  let offsetMs = 0, diaNombre = '', fecha = '';

  async function syncEstado() {
    try {
      const r = await fetch('/api/estado'); const e = await r.json();
      const [h, m] = e.hora.split(':').map(Number);
      const serverLocal = new Date(); serverLocal.setHours(h, m, 0, 0);
      offsetMs = serverLocal - new Date();
      diaNombre = e.dia; fecha = e.fecha;
      $('#fecha').textContent = `${e.dia} ${e.fecha} · zona ${e.tz}`;
    } catch { $('#fecha').textContent = 'No se pudo obtener la hora del servidor.'; }
  }
  function tick() {
    const d = new Date(Date.now() + offsetMs);
    $('#reloj').textContent = d.toTimeString().slice(0, 5);
  }
  setInterval(tick, 1000); syncEstado().then(tick); setInterval(syncEstado, 60000);

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const matricula = input.value.trim();
    if (!matricula) return;
    btn.disabled = true; btn.textContent = 'Registrando…'; out.innerHTML = '';
    try {
      const r = await fetch('/api/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ matricula }) });
      const d = await r.json();
      if (r.ok) {
        out.innerHTML = `<div class="alert ${d.repetido ? 'warn' : 'ok'}">
          <strong>${d.repetido ? 'Ya estabas registrado' : '✓ Asistencia registrada'}</strong>
          ${esc(d.alumno.nombre)}<br>
          ${esc(d.materia.nombre)} · ${esc(d.materia.grupo)}<br>
          <span class="small">${esc(d.fecha)} a las ${esc(d.hora)}${d.totalAsistencias ? ` · ${d.totalAsistencias} asistencia(s) en total` : ''}</span>
        </div>`;
        input.value = '';
      } else {
        out.innerHTML = `<div class="alert err"><strong>${r.status === 403 ? 'Fuera de horario' : 'No se pudo registrar'}</strong>${esc(d.error || 'Error')}${d.detalle ? `<br><span class="small">${esc(d.detalle)}</span>` : ''}</div>`;
      }
    } catch {
      out.innerHTML = '<div class="alert err"><strong>Sin conexión</strong>Inténtalo de nuevo.</div>';
    } finally {
      btn.disabled = false; btn.textContent = 'Registrar asistencia'; input.focus();
    }
  });
})();
