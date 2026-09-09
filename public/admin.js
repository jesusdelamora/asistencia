(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const DIAS = { 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes', 6: 'Sábado', 7: 'Domingo' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const msg = (el, text, type = 'ok') => { el.innerHTML = text ? `<div class="alert ${type}">${esc(text)}</div>` : ''; };

  async function api(url, opts = {}) {
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (r.status === 401 && !url.endsWith('/login')) { showLogin(); throw new Error('Sesión expirada'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
    return d;
  }

  let materias = [], alumnos = [];

  // ---------- Sesión ----------
  function showLogin() { $('#login').classList.remove('hidden'); $('#panel').classList.add('hidden'); $('#logout').classList.add('hidden'); }
  async function showPanel() {
    $('#login').classList.add('hidden'); $('#panel').classList.remove('hidden'); $('#logout').classList.remove('hidden');
    await cargarTodo();
  }
  $('#loginForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    try { await api('/api/admin/login', { method: 'POST', body: { password: $('#password').value } }); $('#password').value = ''; msg($('#loginMsg'), ''); await showPanel(); }
    catch (e) { msg($('#loginMsg'), e.message, 'err'); }
  });
  $('#logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); showLogin(); });

  // ---------- Tabs ----------
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    $$('.tabpane').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${t.dataset.tab}`));
  }));

  // ---------- Carga ----------
  async function cargarTodo() {
    const [resumen, ms] = await Promise.all([api('/api/admin/resumen'), api('/api/admin/materias')]);
    materias = ms;
    $('#ahora').textContent = `${resumen.ahora.dia} ${resumen.ahora.fecha} ${resumen.ahora.hora}`;
    $('#stats').innerHTML = [
      [resumen.materias, 'Materias'], [resumen.alumnos, 'Alumnos'], [resumen.asistenciasHoy, 'Check-ins hoy'],
    ].map(([n, l]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
    $('#tolAntes').value = resumen.ajustes.tolerancia_antes;
    $('#tolDespues').value = resumen.ajustes.tolerancia_despues;
    renderMaterias();
    llenarSelects();
    await Promise.all([cargarAlumnos(), cargarAsistencia()]);
  }

  function llenarSelects() {
    const opts = materias.map(m => `<option value="${m.id}">${esc(m.nombre)} · ${esc(m.grupo)}</option>`).join('');
    const sel = $('#asMateria'); const prev = sel.value; sel.innerHTML = opts; if (prev) sel.value = prev;
    $('#impMateria').innerHTML = '<option value="">— Solo dar de alta, sin materia —</option>' + opts;
    $('#alFiltro').innerHTML = '<option value="">Todas las materias</option>' + opts;
    $('#aMaterias').innerHTML = materias.map(m => `<label class="row" style="font-weight:500"><input type="checkbox" value="${m.id}" style="width:auto"> ${esc(m.nombre)} (${esc(m.grupo)})</label>`).join('') || '<span class="muted small">Primero crea una materia.</span>';
  }

  // ---------- Materias ----------
  function renderMaterias() {
    $('#listaMaterias').innerHTML = materias.map(m => `
      <div class="card materia-card" style="border-left-color:${esc(m.color)}" data-id="${m.id}">
        <div class="row between">
          <div>
            <h3>${esc(m.nombre)} <span class="tag">${esc(m.grupo)}</span> ${m.activa ? '' : '<span class="tag" style="background:#fee2e2;color:#b91c1c">Inactiva</span>'}</h3>
            <div class="small muted">${m.alumnos} alumno(s) inscrito(s)</div>
          </div>
          <div class="row">
            <button class="btn sm secondary" data-act="editar">Editar</button>
            <button class="btn sm secondary" data-act="toggle">${m.activa ? 'Desactivar' : 'Activar'}</button>
            <button class="btn sm danger" data-act="borrar">Eliminar</button>
          </div>
        </div>
        <h4 class="small muted" style="margin:1rem 0 .3rem">Horarios</h4>
        <ul class="list">
          ${m.horarios.map(hr => `<li><span>${DIAS[hr.dia]} · ${esc(hr.hora_inicio)} – ${esc(hr.hora_fin)}</span><button class="btn sm danger" data-act="borrar-horario" data-hid="${hr.id}">Quitar</button></li>`).join('') || '<li class="muted small">Sin horarios: nadie podrá hacer check-in.</li>'}
        </ul>
        <form class="inline-form" data-act="nuevo-horario" style="margin-top:.6rem">
          <div><label>Día</label><select name="dia">${Object.entries(DIAS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div><label>Inicio</label><input type="time" name="inicio" required></div>
          <div><label>Fin</label><input type="time" name="fin" required></div>
          <button class="btn sm secondary" type="submit">Agregar horario</button>
        </form>
      </div>`).join('') || '<div class="card muted">Aún no hay materias.</div>';
  }

  $('#formMateria').addEventListener('submit', async ev => {
    ev.preventDefault();
    try {
      await api('/api/admin/materias', { method: 'POST', body: { nombre: $('#mNombre').value, grupo: $('#mGrupo').value, color: $('#mColor').value } });
      $('#mNombre').value = ''; $('#mGrupo').value = '';
      await cargarTodo();
    } catch (e) { alert(e.message); }
  });

  $('#listaMaterias').addEventListener('click', async ev => {
    const btn = ev.target.closest('button[data-act]'); if (!btn) return;
    const card = btn.closest('.materia-card'); const id = Number(card.dataset.id); const m = materias.find(x => x.id === id);
    try {
      if (btn.dataset.act === 'borrar') {
        if (!confirm(`¿Eliminar "${m.nombre}"? Se borrarán sus horarios, inscripciones y asistencias.`)) return;
        await api(`/api/admin/materias/${id}`, { method: 'DELETE' });
      } else if (btn.dataset.act === 'toggle') {
        await api(`/api/admin/materias/${id}`, { method: 'PUT', body: { activa: !m.activa } });
      } else if (btn.dataset.act === 'editar') {
        const nombre = prompt('Nombre de la materia:', m.nombre); if (nombre === null) return;
        const grupo = prompt('Grupo:', m.grupo); if (grupo === null) return;
        await api(`/api/admin/materias/${id}`, { method: 'PUT', body: { nombre, grupo } });
      } else if (btn.dataset.act === 'borrar-horario') {
        await api(`/api/admin/horarios/${btn.dataset.hid}`, { method: 'DELETE' });
      }
      await cargarTodo();
    } catch (e) { alert(e.message); }
  });
  $('#listaMaterias').addEventListener('submit', async ev => {
    const form = ev.target.closest('form[data-act="nuevo-horario"]'); if (!form) return;
    ev.preventDefault();
    const id = form.closest('.materia-card').dataset.id;
    try {
      await api(`/api/admin/materias/${id}/horarios`, { method: 'POST', body: { dia: Number(form.dia.value), hora_inicio: form.inicio.value, hora_fin: form.fin.value } });
      await cargarTodo();
    } catch (e) { alert(e.message); }
  });

  // ---------- Alumnos ----------
  async function cargarAlumnos() {
    const params = new URLSearchParams();
    if ($('#alFiltro').value) params.set('materia', $('#alFiltro').value);
    if ($('#alBuscar').value.trim()) params.set('q', $('#alBuscar').value.trim());
    alumnos = await api(`/api/admin/alumnos?${params}`);
    $('#alCount').textContent = alumnos.length;
    $('#alTabla').innerHTML = `<thead><tr><th>Matrícula</th><th>Nombre</th><th>Materias</th><th></th></tr></thead><tbody>` +
      alumnos.map(a => `<tr data-id="${a.id}">
        <td>${esc(a.matricula)}</td><td class="name">${esc(a.nombre)}</td>
        <td>${a.materias.map(id => { const m = materias.find(x => x.id === id); return m ? `<span class="tag" style="background:${esc(m.color)}">${esc(m.grupo || m.nombre)}</span> ` : ''; }).join('') || '<span class="muted small">Sin materia</span>'}</td>
        <td class="row"><button class="btn sm secondary" data-act="editar">Editar</button><button class="btn sm danger" data-act="borrar">Eliminar</button></td>
      </tr>`).join('') + '</tbody>';
  }
  $('#alFiltro').addEventListener('change', cargarAlumnos);
  let t; $('#alBuscar').addEventListener('input', () => { clearTimeout(t); t = setTimeout(cargarAlumnos, 250); });

  $('#formAlumno').addEventListener('submit', async ev => {
    ev.preventDefault();
    try {
      await api('/api/admin/alumnos', { method: 'POST', body: {
        matricula: $('#aMatricula').value, nombre: $('#aNombre').value,
        materias: $$('#aMaterias input:checked').map(c => Number(c.value)),
      } });
      $('#aMatricula').value = ''; $('#aNombre').value = '';
      await cargarTodo();
    } catch (e) { alert(e.message); }
  });

  $('#alTabla').addEventListener('click', async ev => {
    const btn = ev.target.closest('button[data-act]'); if (!btn) return;
    const id = Number(btn.closest('tr').dataset.id); const a = alumnos.find(x => x.id === id);
    try {
      if (btn.dataset.act === 'borrar') {
        if (!confirm(`¿Eliminar a ${a.nombre}? Se borrarán también sus asistencias.`)) return;
        await api(`/api/admin/alumnos/${id}`, { method: 'DELETE' });
      } else {
        const matricula = prompt('Matrícula:', a.matricula); if (matricula === null) return;
        const nombre = prompt('Nombre:', a.nombre); if (nombre === null) return;
        const lista = materias.map((m, i) => `${i + 1}. ${m.nombre} (${m.grupo})`).join('\n');
        const actual = materias.map((m, i) => a.materias.includes(m.id) ? i + 1 : null).filter(Boolean).join(',');
        const sel = prompt(`Materias (números separados por coma):\n${lista}`, actual); if (sel === null) return;
        const ids = sel.split(',').map(s => materias[Number(s.trim()) - 1]).filter(Boolean).map(m => m.id);
        await api(`/api/admin/alumnos/${id}`, { method: 'PUT', body: { matricula, nombre, materias: ids } });
      }
      await cargarTodo();
    } catch (e) { alert(e.message); }
  });

  $('#impBtn').addEventListener('click', async () => {
    try {
      const r = await api('/api/admin/alumnos/importar', { method: 'POST', body: { texto: $('#impTexto').value, materia_id: $('#impMateria').value || null } });
      msg($('#impMsg'), `Leídos ${r.leidos}: ${r.nuevos} alumno(s) nuevo(s), ${r.inscritos} inscripción(es) nueva(s).${r.omitidos.length ? ` Líneas omitidas: ${r.omitidos.length}.` : ''}`, r.omitidos.length ? 'warn' : 'ok');
      if (!r.omitidos.length) $('#impTexto').value = '';
      await cargarTodo();
    } catch (e) { msg($('#impMsg'), e.message, 'err'); }
  });

  // ---------- Asistencia ----------
  let asData = null;
  async function cargarAsistencia() {
    const materiaId = $('#asMateria').value;
    if (!materiaId) { $('#asTabla').innerHTML = '<span class="muted">Crea una materia para ver asistencias.</span>'; return; }
    const params = new URLSearchParams({ materia: materiaId });
    if ($('#asDesde').value) params.set('desde', $('#asDesde').value);
    if ($('#asHasta').value) params.set('hasta', $('#asHasta').value);
    $('#asCsv').href = `/api/admin/asistencias/csv?${params}`;
    asData = await api(`/api/admin/asistencias?${params}`);
    renderAsistencia();
  }
  function renderAsistencia() {
    const { alumnos: als, registros } = asData;
    const fechas = [...asData.fechas];
    const extra = $('#asNuevaFecha').value;
    if (extra && !fechas.includes(extra)) fechas.push(extra), fechas.sort();
    const fmt = f => { const [y, m, d] = f.split('-'); return `${d}/${m}`; };
    if (!als.length) { $('#asTabla').innerHTML = '<span class="muted">Esta materia no tiene alumnos inscritos.</span>'; return; }
    $('#asTabla').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Matrícula</th><th>Nombre</th>${fechas.map(f => `<th title="${f}">${fmt(f)}</th>`).join('')}<th>Total</th><th>%</th></tr></thead>
      <tbody>${als.map(a => {
        const regs = fechas.map(f => registros.find(r => r.alumno_id === a.id && r.fecha === f));
        const total = regs.filter(Boolean).length;
        const pct = fechas.length ? Math.round(total * 100 / fechas.length) : 0;
        return `<tr><td>${esc(a.matricula)}</td><td class="name">${esc(a.nombre)}</td>
          ${fechas.map((f, i) => `<td><button class="check ${regs[i] ? 'on' : ''} ${regs[i]?.origen === 'manual' ? 'manual' : ''}" data-alumno="${a.id}" data-fecha="${f}" title="${regs[i] ? `Registrado ${regs[i].hora} (${regs[i].origen})` : 'Sin asistencia'}">${regs[i] ? '✓' : ''}</button></td>`).join('')}
          <td><strong>${total}</strong>/${fechas.length}</td><td>${pct}%</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }
  $('#asBuscar').addEventListener('click', cargarAsistencia);
  $('#asMateria').addEventListener('change', cargarAsistencia);
  $('#asNuevaFecha').addEventListener('change', () => asData && renderAsistencia());
  $('#asTabla').addEventListener('click', async ev => {
    const b = ev.target.closest('button.check'); if (!b) return;
    const body = { alumno_id: Number(b.dataset.alumno), materia_id: Number($('#asMateria').value), fecha: b.dataset.fecha };
    try {
      await api('/api/admin/asistencias', { method: b.classList.contains('on') ? 'DELETE' : 'POST', body });
      await cargarAsistencia();
    } catch (e) { alert(e.message); }
  });

  // ---------- Ajustes ----------
  $('#formAjustes').addEventListener('submit', async ev => {
    ev.preventDefault();
    try {
      await api('/api/admin/ajustes', { method: 'PUT', body: { tolerancia_antes: Number($('#tolAntes').value), tolerancia_despues: Number($('#tolDespues').value) } });
      msg($('#ajMsg'), 'Ajustes guardados.');
    } catch (e) { msg($('#ajMsg'), e.message, 'err'); }
  });

  // ---------- Inicio ----------
  api('/api/admin/me').then(d => d.admin ? showPanel() : showLogin()).catch(showLogin);
})();
