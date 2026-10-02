'use strict';

/* Utilidades compartidas por las tres vistas. Todo el contenido de usuario
   se inserta con textContent para evitar inyección de HTML. */

const FACES = {
  feliz: { emoji: '😄', label: 'Feliz · correcta y rápida' },
  enojada: { emoji: '😠', label: 'Enojada · correcta pero lenta' },
  triste: { emoji: '😢', label: 'Triste · incorrecta' },
  llorando: { emoji: '😭', label: 'Llorando · sin respuesta' },
};

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function faceEmoji(face) {
  return FACES[face] ? FACES[face].emoji : '—';
}

/** Nodo con la flecha de cambio de posición: ▲2 subió, ▼1 bajó, = igual.
    Antes de la segunda pregunta no hay comparación y no se pinta nada. */
function deltaNode(delta) {
  if (delta == null) return el('span', 'delta same', '');
  if (delta > 0) return el('span', 'delta up', `▲${delta}`);
  if (delta < 0) return el('span', 'delta down', `▼${Math.abs(delta)}`);
  return el('span', 'delta same', '=');
}

/** Fila de ranking con barra proporcional al puntaje máximo. */
function rankRow({ position, name, score, maxScore, extras, isMe, delta }) {
  const row = el('div', 'rankrow');
  if (position === 1) row.classList.add('top1');
  if (position === 2) row.classList.add('top2');
  if (position === 3) row.classList.add('top3');
  if (isMe) row.classList.add('me');

  const bar = el('div', 'bar');
  const pct = maxScore > 0 ? Math.max(0, Math.min(100, (score / maxScore) * 100)) : 0;
  bar.style.width = pct + '%';
  row.appendChild(bar);

  row.appendChild(el('span', 'pos num', String(position)));

  const who = el('div', 'who');
  who.appendChild(el('span', 'name', name));
  if (delta !== undefined) who.appendChild(deltaNode(delta));
  row.appendChild(who);

  const right = el('div', 'score');
  if (extras) right.appendChild(extras);
  right.appendChild(el('span', 'num', String(score)));
  row.appendChild(right);

  return row;
}

/** Aplica la identidad visual (data/branding.json) a los elementos marcados
    con data-brand: logo, entidad, proceso, actividad, lema. */
function applyBranding() {
  fetch('/api/branding')
    .then((r) => r.json())
    .then((b) => {
      for (const node of document.querySelectorAll('[data-brand]')) {
        const key = node.dataset.brand;
        if (node.tagName === 'IMG') {
          // logo, banner, o cualquier imagen de marca
          if (b[key]) { node.src = b[key]; node.hidden = false; }
          else node.hidden = true;
        } else if (b[key]) {
          node.textContent = b[key];
        }
      }
      if (b.proceso) {
        document.title = (b.actividad ? b.actividad + ' · ' : '') + b.proceso;
      }
    })
    .catch(() => {});
}
document.addEventListener('DOMContentLoaded', applyBranding);

let toastTimer = null;
function toast(message) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = el('div', 'toast');
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

/** Temporizador visual basado en el reloj del servidor (deadline absoluto). */
function makeCountdown(barEl, clockEl, onDone) {
  let raf = null;
  let deadline = null;
  let totalMs = null;
  function tick() {
    const remaining = deadline - Date.now();
    if (clockEl) clockEl.textContent = fmtClock(remaining);
    if (barEl) {
      const inner = barEl.firstElementChild;
      const pct = totalMs > 0 ? Math.max(0, Math.min(100, (remaining / totalMs) * 100)) : 0;
      inner.style.width = pct + '%';
      barEl.classList.toggle('low', remaining < totalMs * 0.2);
    }
    if (remaining <= 0) {
      stop();
      if (onDone) onDone();
      return;
    }
    raf = requestAnimationFrame(tick);
  }
  function start(deadlineTs, limitSec) {
    stop();
    deadline = deadlineTs;
    totalMs = limitSec * 1000;
    tick();
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }
  return { start, stop };
}
