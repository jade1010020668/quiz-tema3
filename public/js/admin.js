'use strict';

/* Panel del supervisor: dirige la sesión (activar/cerrar preguntas, vista
   de la pantalla proyectada, sorteo, reinicio), administra participantes y
   edita el banco de preguntas. */

const socket = io();

const loginView = document.getElementById('view-login');
const mainView = document.getElementById('view-main');

let state = null;

const countdown = makeCountdown(
  document.getElementById('st-bar'),
  document.getElementById('st-clock')
);

function call(event, payload, okMessage) {
  socket.emit(event, payload || {}, (res) => {
    if (!res || !res.ok) toast((res && res.error) || 'La acción no se pudo completar.');
    else if (okMessage) toast(okMessage);
  });
}

function login(code) {
  socket.emit('admin:login', { code }, (res) => {
    if (!res.ok) {
      toast(res.error || 'Código incorrecto.');
      localStorage.removeItem('vrm_admin_code');
      loginView.hidden = false;
      mainView.hidden = true;
      return;
    }
    localStorage.setItem('vrm_admin_code', code);
    loginView.hidden = true;
    mainView.hidden = false;
  });
}

document.getElementById('login-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  login(document.getElementById('login-code').value);
});

socket.on('connect', () => {
  const saved = localStorage.getItem('vrm_admin_code');
  if (saved) login(saved);
  else loginView.hidden = false;
});

function setLink(id, url) {
  const a = document.getElementById(id);
  if (!a) return;
  a.href = url;
  a.textContent = url;
}

// Enlaces de las tres vistas (usan la IP de red local para que el QR funcione).
fetch('/api/urls')
  .then((r) => r.json())
  .then((u) => {
    setLink('join-link', u.participant);
    setLink('url-participant', u.participant);
    setLink('url-pantalla', u.pantalla);
    setLink('url-admin', u.admin);
  })
  .catch(() => {});

// Botones «Copiar enlace».
for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', () => {
    const target = document.getElementById(btn.dataset.copy);
    const url = target ? target.href : '';
    if (!url) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        () => toast('Enlace copiado.'),
        () => toast(url)
      );
    } else {
      toast(url);
    }
  });
}

// ---------- controles ----------

document.getElementById('btn-next').addEventListener('click', () => {
  call('admin:start_question', {}, 'Pregunta activada.');
});

document.getElementById('btn-close').addEventListener('click', () => {
  call('admin:close_question', {}, 'Pregunta cerrada.');
});

for (const btn of document.querySelectorAll('[data-screen]')) {
  btn.addEventListener('click', () => call('admin:set_screen', { view: btn.dataset.screen }));
}

document.getElementById('btn-sorteo').addEventListener('click', () => {
  call('admin:sorteo', {}, 'Sorteo realizado: mira la pantalla.');
});

document.getElementById('btn-reset').addEventListener('click', () => {
  if (confirm('¿Reiniciar la sesión? Se borran participantes, respuestas y puntajes. Las preguntas se conservan.')) {
    call('admin:reset_session', {}, 'Sesión reiniciada.');
  }
});

// Respaldo de resultados: el servicio pierde la sesión al reiniciarse o dormirse.
function descargarResultados(tipo) {
  const code = localStorage.getItem('vrm_admin_code') || '';
  if (!code) {
    alert('Vuelve a ingresar el código de acceso para poder descargar.');
    return;
  }
  window.location.href =
    '/api/resultados.csv?tipo=' + encodeURIComponent(tipo) + '&code=' + encodeURIComponent(code);
}

document.getElementById('btn-csv-resumen').addEventListener('click', () => descargarResultados('resumen'));
document.getElementById('btn-csv-detalle').addEventListener('click', () => descargarResultados('detalle'));

// ---------- render ----------

const PHASE_LABEL = {
  lobby: 'En espera',
  question: 'Pregunta activa',
  closed: 'Pregunta cerrada',
};

function render() {
  if (!state) return;

  document.getElementById('st-phase').textContent = PHASE_LABEL[state.phase] || state.phase;
  document.getElementById('st-connected').textContent = String(state.counts.connected);
  document.getElementById('st-registered').textContent = String(state.counts.participants);
  document.getElementById('st-answered').textContent =
    state.phase === 'question'
      ? `${state.counts.answeredCurrent}/${state.counts.connected}`
      : '—';

  if (state.phase === 'question' && state.deadline) {
    const active = state.questions.find((q) => q.id === state.currentId);
    countdown.start(state.deadline, active ? active.timeLimitSec : 180);
  } else {
    countdown.stop();
    document.getElementById('st-clock').textContent = '—';
    document.getElementById('st-bar').firstElementChild.style.width = '0%';
  }

  document.getElementById('btn-next').disabled =
    state.phase === 'question' || !state.nextPendingId;
  document.getElementById('btn-close').disabled = state.phase !== 'question';

  renderQuestions();
  renderParticipants();
}

function renderQuestions() {
  const box = clear(document.getElementById('qlist'));
  for (const q of state.questions) {
    const item = el('div', 'qitem');
    item.appendChild(el('span', 'qnum num', String(q.number)));

    const mid = el('div');
    const line = el('div', 'qtext', q.text);
    line.title = q.text;
    mid.appendChild(line);
    const meta = el('div', 'muted');
    meta.style.fontSize = '0.8rem';
    let metaText = `${q.options.length} opciones · ${q.timeLimitSec}s · correcta: ${LETTERS[q.correctIndex]}`;
    if (q.stats) {
      metaText += ` · ${q.stats.correct}/${q.stats.total} acertaron`;
    }
    meta.textContent = metaText;
    mid.appendChild(meta);
    item.appendChild(mid);

    const actions = el('div', 'qactions');
    const projecting = state.reviewId === q.id && state.screen === 'question_ranking';
    actions.appendChild(
      el('span', `badge ${projecting ? 'activa' : q.status}`, projecting ? 'proyectando' : q.status)
    );
    if (q.status === 'jugada') {
      const proj = el('button', 'btn', '📺');
      proj.title = 'Proyectar los resultados de esta pregunta en la pantalla';
      proj.addEventListener('click', () =>
        call('admin:review_question', { id: q.id }, `Proyectando la pregunta ${q.number}.`)
      );
      const det = el('button', 'btn', '👁');
      det.title = 'Ver quién respondió bien y quién mal';
      det.addEventListener('click', () => openDetail(q));
      actions.appendChild(proj);
      actions.appendChild(det);
    }
    if (q.status === 'pendiente') {
      const play = el('button', 'btn', '▶');
      play.title = 'Activar esta pregunta';
      play.addEventListener('click', () =>
        call('admin:start_question', { id: q.id }, `Pregunta ${q.number} activada.`)
      );
      const edit = el('button', 'btn', '✎');
      edit.title = 'Editar';
      edit.addEventListener('click', () => openEditor(q));
      const del = el('button', 'btn btn-danger', '✕');
      del.title = 'Eliminar';
      del.addEventListener('click', () => {
        if (confirm(`¿Eliminar la pregunta ${q.number}?`)) {
          call('admin:question_delete', { id: q.id }, 'Pregunta eliminada.');
        }
      });
      actions.appendChild(play);
      actions.appendChild(edit);
      actions.appendChild(del);
    }
    item.appendChild(actions);
    box.appendChild(item);
  }
  if (!state.questions.length) {
    box.appendChild(el('p', 'muted', 'No hay preguntas. Crea la primera con «Nueva pregunta».'));
  }
}

function renderParticipants() {
  const tbody = clear(document.getElementById('plist'));
  for (const p of state.participants) {
    const tr = el('tr');

    const tdPos = el('td', 'num', p.position ? String(p.position) : '—');
    tr.appendChild(tdPos);

    tr.appendChild(el('td', null, p.name));

    const tdConn = el('td');
    const dot = el('span', `dot ${p.connected ? 'on' : 'off'}`);
    dot.title = p.connected ? 'Conectado' : 'Desconectado';
    tdConn.appendChild(dot);
    if (state.phase === 'question') {
      tdConn.appendChild(document.createTextNode(p.answeredCurrent ? ' ✓' : ' …'));
    }
    tr.appendChild(tdConn);

    tr.appendChild(el('td', 'num', String(p.totalScore)));

    const tdAct = el('td');
    const del = el('button', 'btn btn-danger', '✕');
    del.title = 'Retirar participante';
    del.style.padding = '2px 8px';
    del.addEventListener('click', () => {
      if (confirm(`¿Retirar a ${p.name} de la sesión?`)) {
        call('admin:remove_participant', { token: p.token }, 'Participante retirado.');
      }
    });
    tdAct.appendChild(del);
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  }
  if (!state.participants.length) {
    const tr = el('tr');
    const td = el('td', 'muted', 'Aún no hay participantes. Comparte el QR desde la pantalla.');
    td.colSpan = 5;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

// ---------- editor de preguntas ----------

const qmodal = document.getElementById('qmodal');
const qform = document.getElementById('qform');
let editingId = null;

function optionRow(value, checked) {
  const row = el('div', 'optrow');
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'correct';
  radio.checked = !!checked;
  radio.title = 'Marcar como correcta';
  const input = document.createElement('input');
  input.className = 'input';
  input.maxLength = 200;
  input.placeholder = 'Texto de la opción';
  input.value = value || '';
  const remove = el('button', 'btn', '✕');
  remove.type = 'button';
  remove.title = 'Quitar opción';
  remove.addEventListener('click', () => {
    if (document.querySelectorAll('#qf-options .optrow').length > 2) row.remove();
    else toast('Se necesitan al menos 2 opciones.');
  });
  row.appendChild(radio);
  row.appendChild(input);
  row.appendChild(remove);
  return row;
}

function openEditor(q) {
  editingId = q ? q.id : null;
  document.getElementById('qform-title').textContent = q
    ? `Editar pregunta ${q.number}`
    : 'Nueva pregunta';
  document.getElementById('qf-text').value = q ? q.text : '';
  document.getElementById('qf-time').value = q ? q.timeLimitSec : 180;
  document.getElementById('qf-sustento').value = q && q.sustento ? q.sustento : '';
  const box = clear(document.getElementById('qf-options'));
  const options = q ? q.options : ['', '', '', ''];
  options.forEach((opt, i) => {
    box.appendChild(optionRow(opt, q ? i === q.correctIndex : i === 0));
  });
  qmodal.hidden = false;
}

document.getElementById('btn-addq').addEventListener('click', () => openEditor(null));
document.getElementById('qf-cancel').addEventListener('click', () => (qmodal.hidden = true));
document.getElementById('qf-addopt').addEventListener('click', () => {
  const rows = document.querySelectorAll('#qf-options .optrow');
  if (rows.length >= 6) return toast('Máximo 6 opciones.');
  document.getElementById('qf-options').appendChild(optionRow('', false));
});

qform.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const rows = [...document.querySelectorAll('#qf-options .optrow')];
  const question = {
    text: document.getElementById('qf-text').value,
    options: rows.map((r) => r.querySelector('input.input').value),
    correctIndex: rows.findIndex((r) => r.querySelector('input[type="radio"]').checked),
    timeLimitSec: Number(document.getElementById('qf-time').value),
    sustento: document.getElementById('qf-sustento').value,
  };
  const done = (res) => {
    if (!res.ok) return toast(res.error || 'No se pudo guardar.');
    qmodal.hidden = true;
    toast('Pregunta guardada.');
  };
  if (editingId) socket.emit('admin:question_update', { id: editingId, question }, done);
  else socket.emit('admin:question_add', { question }, done);
});

// ---------- detalle de una pregunta jugada (quién acertó / quién falló) ----------

function openDetail(q) {
  socket.emit('admin:question_detail', { id: q.id }, (res) => {
    if (!res || !res.ok || !res.detail) {
      return toast((res && res.error) || 'No se pudo cargar el detalle.');
    }
    renderDetailModal(res.detail);
  });
}

function renderDetailModal(d) {
  const q = d.question;
  document.getElementById('detail-title').textContent = `Pregunta ${q.number} · detalle`;
  document.getElementById('detail-question').textContent = q.text;
  document.getElementById('detail-correct').textContent =
    `Respuesta correcta: ${LETTERS[q.correctIndex]}. ${q.options[q.correctIndex]}`;

  // distribución de respuestas por opción
  const dist = clear(document.getElementById('detail-dist'));
  const maxCount = Math.max(...d.stats.perOption, 1);
  q.options.forEach((optText, i) => {
    const row = el('div', 'drow');
    row.dataset.i = String(i);
    if (i === q.correctIndex) row.classList.add('correct');
    row.title = optText;
    row.appendChild(el('span', 'dlabel', LETTERS[i]));
    const track = el('div', 'dtrack');
    const fill = el('div', 'dfill');
    fill.style.width = (d.stats.perOption[i] / maxCount) * 100 + '%';
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('span', 'dcount num', String(d.stats.perOption[i])));
    dist.appendChild(row);
  });

  // grupos: contestaron bien / mal / no respondieron
  const correct = d.entries.filter((e) => e.correct);
  const wrong = d.entries.filter((e) => !e.correct && e.choice != null);
  const none = d.entries.filter((e) => e.choice == null);
  const groups = clear(document.getElementById('detail-groups'));
  const grp = (cls, title, list, fmt) => {
    const g = el('div', `detail-group ${cls}`);
    g.appendChild(el('h4', null, `${title} (${list.length})`));
    const names = el('div', 'detail-names');
    if (!list.length) names.appendChild(el('span', 'muted', '—'));
    for (const e of list) names.appendChild(el('span', 'nm', fmt(e)));
    g.appendChild(names);
    groups.appendChild(g);
  };
  grp('ok', '✅ Contestaron bien', correct, (e) => `${e.name} · +${e.score}`);
  grp('bad', '❌ Contestaron mal', wrong, (e) => `${e.name} → ${LETTERS[e.choice]}`);
  grp('none', '😴 No respondieron', none, (e) => e.name);

  // Botones de sorteo por grupo (caritas)
  const sbox = clear(document.getElementById('detail-sorteo-btns'));
  const grupos = [
    ['feliz', '😄 Bien y rápido'],
    ['enojada', '😠 Bien pero lento'],
    ['triste', '😢 Mal'],
    ['llorando', '😭 Sin responder'],
  ];
  for (const [cat, label] of grupos) {
    const count = (d.stats.faces && d.stats.faces[cat]) || 0;
    const b = el('button', 'btn', `${label} (${count})`);
    b.type = 'button';
    b.disabled = count === 0;
    b.addEventListener('click', () => {
      call('admin:sorteo', { questionId: q.id, category: cat }, 'Sorteo realizado: mira la pantalla.');
      closeDetail();
    });
    sbox.appendChild(b);
  }

  document.getElementById('detail-project').onclick = () => {
    call('admin:review_question', { id: q.id }, `Proyectando la pregunta ${q.number}.`);
    closeDetail();
  };
  document.getElementById('detailmodal').hidden = false;
}

function closeDetail() {
  document.getElementById('detailmodal').hidden = true;
}

document.getElementById('detail-close').addEventListener('click', closeDetail);
document.getElementById('detailmodal').addEventListener('click', (ev) => {
  if (ev.target.id === 'detailmodal') closeDetail();
});

socket.on('admin:state', (snapshot) => {
  state = snapshot;
  render();
});
