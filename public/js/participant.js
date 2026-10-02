'use strict';

/* Vista del participante: registro por nombre, respuesta a la pregunta
   activa, resultado inmediato con carita y posición en el ranking. */

const socket = io();

const views = {
  join: document.getElementById('view-join'),
  lobby: document.getElementById('view-lobby'),
  question: document.getElementById('view-question'),
  answered: document.getElementById('view-answered'),
  result: document.getElementById('view-result'),
};

const store = {
  get token() { return localStorage.getItem('vrm_token') || null; },
  set token(v) { v ? localStorage.setItem('vrm_token', v) : localStorage.removeItem('vrm_token'); },
  get name() { return localStorage.getItem('vrm_name') || ''; },
  set name(v) { localStorage.setItem('vrm_name', v || ''); },
};

let state = null;
let renderedQuestionId = null;
let chosenIndex = null;

const countdown = makeCountdown(
  document.getElementById('q-bar'),
  document.getElementById('q-clock')
);

function show(name) {
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
}

function joinSession(name, token) {
  socket.emit('participant:join', { name, token }, (res) => {
    if (!res.ok) {
      store.token = null;
      show('join');
      if (name || token) toast(res.error || 'No fue posible ingresar.');
      return;
    }
    store.token = res.token;
    store.name = res.name;
    document.getElementById('me-name').textContent = res.name;
  });
}

// Exige nombre completo (nombre + apellido). Debe coincidir con la validación
// del servidor en lib/game.js.
function isFullName(name) {
  if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ.'\- ]+$/.test(name)) return false;
  const words = name.split(' ').filter((w) => /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(w));
  if (words.length < 2) return false;
  return name.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, '').length >= 5;
}

document.getElementById('join-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const name = document.getElementById('join-name').value.trim().replace(/\s+/g, ' ');
  if (!isFullName(name)) {
    toast('Escribe tu nombre y apellidos completos (al menos un nombre y un apellido).');
    const hint = document.getElementById('join-hint');
    if (hint) { hint.textContent = 'Ejemplo válido: María Fernanda Gómez Ruiz'; hint.style.color = 'var(--critical)'; }
    document.getElementById('join-name').focus();
    return;
  }
  joinSession(name, null);
});

function renderQuestion(q, me) {
  const numberEl = document.getElementById('q-number');
  numberEl.textContent = `Pregunta ${q.playedBefore + 1}`;
  document.getElementById('q-text').textContent = q.text;

  if (renderedQuestionId !== q.id) {
    renderedQuestionId = q.id;
    chosenIndex = null;
    const box = clear(document.getElementById('q-options'));
    q.options.forEach((optText, i) => {
      const btn = el('button', 'opt');
      btn.dataset.i = String(i);
      btn.type = 'button';
      btn.appendChild(el('span', 'letter', LETTERS[i]));
      btn.appendChild(el('span', null, optText));
      btn.addEventListener('click', () => sendAnswer(i));
      box.appendChild(btn);
    });
  }
  countdown.start(q.deadline, q.timeLimitSec);
}

function sendAnswer(i) {
  if (chosenIndex != null) return;
  chosenIndex = i;
  for (const btn of document.querySelectorAll('#q-options .opt')) {
    btn.disabled = true;
    if (Number(btn.dataset.i) === i) btn.classList.add('chosen');
  }
  socket.emit('participant:answer', { choice: i }, (res) => {
    if (!res.ok) {
      toast(res.error || 'No se pudo registrar tu respuesta.');
      chosenIndex = null;
      for (const btn of document.querySelectorAll('#q-options .opt')) {
        btn.disabled = false;
        btn.classList.remove('chosen');
      }
    }
  });
}

function renderAnswered(me) {
  const r = me.lastResult;
  const face = document.getElementById('ans-face');
  const verdict = document.getElementById('ans-verdict');
  const points = document.getElementById('ans-points');
  if (r && !r.pending) {
    face.textContent = r.faceEmoji;
    verdict.textContent = r.correct ? '¡Correcta!' : 'Incorrecta';
    points.textContent = `+${r.score} puntos`;
  } else {
    face.textContent = '📨';
    verdict.textContent = 'Respuesta enviada';
    points.textContent = '';
  }
  document.getElementById('ans-note').textContent =
    'Esperando a que todos respondan o termine el tiempo…';
}

function renderResult(me) {
  const r = me.lastResult;
  const s = me.standing;

  const faceNode = document.getElementById('res-face');
  const verdict = document.getElementById('res-verdict');
  const points = document.getElementById('res-points');
  const correctLine = document.getElementById('res-correct');

  if (r) {
    faceNode.textContent = r.faceEmoji;
    verdict.textContent = r.correct
      ? '¡Correcta!'
      : r.face === 'llorando'
        ? 'Sin respuesta (0 puntos)'
        : 'Incorrecta';
    points.textContent = `+${r.score} puntos en la pregunta ${r.questionNumber}`;
    correctLine.textContent = r.revealed
      ? `Respuesta correcta: ${LETTERS[r.correctIndex]}. ${r.correctText}`
      : '';
  } else {
    faceNode.textContent = '🙂';
    verdict.textContent = 'Sin participación en la última pregunta';
    points.textContent = '';
    correctLine.textContent = '';
  }

  const standingBox = clear(document.getElementById('res-standing'));
  if (s && s.position) {
    const pill = el('span', 'standing-pill');
    pill.appendChild(el('span', 'num', `Puesto ${s.position} de ${s.totalParticipants}`));
    if (s.delta != null) pill.appendChild(deltaNode(s.delta));
    pill.appendChild(el('span', 'num', `· ${s.total} pts`));
    standingBox.appendChild(pill);
  }

  const topCard = document.getElementById('res-topcard');
  const topBox = clear(document.getElementById('res-top'));
  if (s && s.top && s.top.length) {
    topCard.hidden = false;
    const max = Math.max(...s.top.map((t) => t.total), 1);
    for (const t of s.top) {
      topBox.appendChild(
        rankRow({
          position: t.position,
          name: t.name,
          score: t.total,
          maxScore: max,
          delta: t.delta,
          isMe: t.name === (state.me ? state.me.name : ''),
        })
      );
    }
  } else {
    topCard.hidden = true;
  }
}

function render() {
  if (!state) return;
  const me = state.me;
  document.getElementById('me-name').textContent = me ? me.name : '';

  if (!me) {
    countdown.stop();
    show('join');
    return;
  }

  if (state.phase === 'question' && state.question) {
    if (me.answeredCurrent) {
      countdown.stop();
      renderAnswered(me);
      show('answered');
    } else {
      renderQuestion(state.question, me);
      show('question');
    }
    return;
  }

  countdown.stop();
  renderedQuestionId = null;

  if (state.playedCount > 0 && me.lastResult) {
    renderResult(me);
    show('result');
  } else {
    document.getElementById('lobby-count').textContent =
      `${state.counts.participants} participante(s) registrados`;
    document.getElementById('lobby-sub').textContent =
      state.playedCount > 0
        ? 'Espera a que el supervisor active la siguiente pregunta.'
        : 'La sesión comenzará en un momento. Espera la primera pregunta.';
    show('lobby');
  }
}

socket.on('participant:state', (snapshot) => {
  state = snapshot;
  render();
});

socket.on('session:reset', () => {
  store.token = null;
  state = null;
  renderedQuestionId = null;
  chosenIndex = null;
  countdown.stop();
  show('join');
  toast('La sesión fue reiniciada por el supervisor. Ingresa de nuevo.');
});

socket.on('connect', () => {
  if (store.token) {
    joinSession(store.name, store.token);
  } else {
    show('join');
  }
});

socket.on('disconnect', () => toast('Conexión perdida. Reconectando…'));
