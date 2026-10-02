'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Game } = require('./lib/game');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
// Código con el que ingresan el supervisor (/admin) y la pantalla proyectada (/pantalla).
const ADMIN_CODE = process.env.ADMIN_CODE || '123456789';
// URL pública que codifica el QR; si no se define se usa el host de la petición.
const PUBLIC_URL = process.env.PUBLIC_URL || null;

const DATA_DIR = path.join(__dirname, 'data');
// Cada despliegue (jornada) elige su examen y su archivo de sesión por variable de entorno,
// para tener preguntas y PUNTUACIÓN independientes. Por defecto: questions.json / session.json.
const QUESTIONS_FILE = path.join(DATA_DIR, process.env.QUESTIONS_FILE || 'questions.json');
const SESSION_FILE = path.join(DATA_DIR, process.env.SESSION_FILE || 'session.json');

const gameOpts = {
  showResultOnAnswer: process.env.SHOW_RESULT_ON_ANSWER !== 'false',
  autoCloseWhenAllAnswered: process.env.AUTO_CLOSE !== 'false',
};

function loadGame() {
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const json = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      const game = Game.restore(json, gameOpts);
      console.log('Sesión anterior restaurada desde data/session.json');
      return game;
    } catch (err) {
      console.warn('No se pudo restaurar la sesión anterior:', err.message);
    }
  }
  let questions = [];
  try {
    questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  } catch (err) {
    console.warn('No se pudo leer data/questions.json:', err.message);
  }
  return new Game(questions, gameOpts);
}

const game = loadGame();

// ---------- persistencia (con pequeño retardo para agrupar escrituras) ----------

let persistTimer = null;
function persistSession() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SESSION_FILE, JSON.stringify(game.toJSON()));
    } catch (err) {
      console.warn('No se pudo guardar la sesión:', err.message);
    }
  }, 250);
}

function persistQuestions() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(game.questions, null, 2));
  } catch (err) {
    console.warn('No se pudo guardar data/questions.json:', err.message);
  }
}

// ---------- servidor HTTP ----------

const app = express();
// Detrás de un proxy (Hugging Face Spaces, Render, etc.) respeta
// x-forwarded-proto para que el QR se genere con la URL https correcta.
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get(['/pantalla', '/screen'], (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'pantalla.html'))
);

function joinUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  return `${req.protocol}://${req.get('host')}/`;
}

// Base en la red local (WiFi del salón): prioriza PUBLIC_URL, luego la IP IPv4
// local con el puerto real y, como último recurso, el host de la petición. Así
// los enlaces del panel apuntan a una dirección que los celulares SÍ alcanzan,
// aunque el supervisor haya abierto /admin como «localhost».
function lanBase(req) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/+$/, '');
  const addr = server.address();
  const port = (addr && addr.port) || PORT;
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if ((net.family === 'IPv4' || net.family === 4) && !net.internal) {
        return `http://${net.address}:${port}`;
      }
    }
  }
  return `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
}

app.get('/api/join-url', (req, res) => res.json({ url: joinUrl(req) }));

// Enlaces de las tres vistas para el panel del supervisor.
app.get('/api/urls', (req, res) => {
  const base = lanBase(req);
  res.json({
    base,
    participant: base + '/',
    admin: base + '/admin',
    pantalla: base + '/pantalla',
  });
});

// Identidad visual (nombre del proceso, entidad, logo). Editable en
// data/branding.json sin tocar código.
const BRANDING_FILE = path.join(DATA_DIR, 'branding.json');
app.get('/api/branding', (req, res) => {
  try {
    const b = JSON.parse(fs.readFileSync(BRANDING_FILE, 'utf8'));
    // Cada despliegue (jornada) puede sobrescribir la etiqueta de actividad.
    if (process.env.JORNADA_LABEL) b.actividad = process.env.JORNADA_LABEL;
    res.json(b);
  } catch (err) {
    res.json({ entidad: 'Manejo Integrado de Plagas', proceso: 'Quiz Tema 3', actividad: process.env.JORNADA_LABEL || 'Capacitación', logo: null });
  }
});

// ---------- respaldo de resultados ----------
// El plan Free de Render tiene disco efímero: la sesión se pierde cuando el
// servicio se reinicia o se duerme. Esto permite bajar el marcador antes de
// cerrar la jornada. Pide el código del supervisor.

const LETRA = ['A', 'B', 'C', 'D', 'E', 'F'];

function csvEscapar(v) {
  const s = v == null ? '' : String(v);
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const BOM = '﻿'; // Excel necesita el BOM para leer bien las tildes

function aCsv(filas) {
  // "sep=;" hace que Excel en español separe por columnas sin pedir nada.
  return BOM + 'sep=;\r\n' + filas.map((f) => f.map(csvEscapar).join(';')).join('\r\n') + '\r\n';
}

function filasResumen() {
  const ranking = game.accumulatedRanking();
  const filas = [['Posicion', 'Participante', 'Aciertos', 'Preguntas jugadas', 'Respondidas', 'Puntaje total', 'Tiempo total (s)', 'Conectado al cierre']];
  for (const r of ranking) {
    filas.push([
      r.position,
      r.name,
      r.correct,
      game.playedIds.length,
      r.answeredCount,
      r.total,
      (r.timeSumMs / 1000).toFixed(1),
      r.connected ? 'Si' : 'No',
    ]);
  }
  return filas;
}

function filasDetalle() {
  const filas = [['Participante', 'N pregunta', 'Id', 'Enunciado', 'Respondio', 'Texto elegido', 'Correcta', 'Acerto', 'Puntaje', 'Tiempo (s)']];
  const participantes = [...game.participants.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  for (const p of participantes) {
    for (const qid of game.playedIds) {
      const q = game.findQuestion(qid);
      if (!q) continue;
      const a = p.answers[qid] || {};
      filas.push([
        p.name,
        game.questionNumber(qid),
        qid,
        q.text,
        a.choice == null ? 'Sin responder' : LETRA[a.choice],
        a.choice == null ? '' : q.options[a.choice],
        LETRA[q.correctIndex],
        a.correct ? 'Si' : 'No',
        a.score || 0,
        a.elapsedMs == null ? '' : (a.elapsedMs / 1000).toFixed(1),
      ]);
    }
  }
  return filas;
}

app.get('/api/resultados.csv', (req, res) => {
  if (String(req.query.code || '') !== ADMIN_CODE) {
    return res.status(401).type('text/plain; charset=utf-8').send('Código de acceso incorrecto.');
  }
  const tipo = req.query.tipo === 'detalle' ? 'detalle' : 'resumen';
  if (game.participants.size === 0) {
    return res.status(409).type('text/plain; charset=utf-8').send('Todavía no hay participantes registrados en esta sesión.');
  }
  const jornada = (process.env.JORNADA_LABEL || 'jornada')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita las tildes para el nombre del archivo
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  const sello = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const nombre = `resultados-${tipo}-${jornada}-${sello}.csv`;
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.type('text/csv; charset=utf-8').send(aCsv(tipo === 'detalle' ? filasDetalle() : filasResumen()));
});

app.get('/api/qr.svg', async (req, res) => {
  try {
    const to = req.query.to;
    let target = joinUrl(req); // sin parámetro: URL de participantes (portada)
    if (to === 'admin') target = lanBase(req) + '/admin';
    else if (to === 'pantalla') target = lanBase(req) + '/pantalla';
    else if (to === 'participant') target = lanBase(req) + '/';
    const svg = await QRCode.toString(target, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0b0b', light: '#ffffff' },
    });
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    res.status(500).send('No se pudo generar el código QR');
  }
});

// ---------- temporizador de la pregunta (el servidor manda) ----------

let questionTimer = null;

function armQuestionTimer() {
  clearTimeout(questionTimer);
  questionTimer = null;
  if (game.phase === 'question' && game.deadline) {
    const wait = Math.max(0, game.deadline - Date.now()) + 50;
    questionTimer = setTimeout(() => {
      if (game.closeQuestion(Date.now())) afterChange();
    }, wait);
  }
}

// ---------- difusión de estado por rol ----------

const participantSockets = new Map(); // token -> Set<socketId>

function broadcastState() {
  io.to('admins').emit('admin:state', game.adminSnapshot());
  io.to('screens').emit('screen:state', game.screenSnapshot());
  for (const [token, ids] of participantSockets) {
    if (ids.size === 0) continue;
    const snapshot = game.participantSnapshot(token);
    for (const id of ids) io.to(id).emit('participant:state', snapshot);
  }
}

function afterChange() {
  armQuestionTimer();
  persistSession();
  broadcastState();
}

function safe(handler) {
  return (payload, cb) => {
    try {
      const result = handler(payload || {});
      if (typeof cb === 'function') cb({ ok: true, ...(result || {}) });
    } catch (err) {
      if (typeof cb === 'function') cb({ ok: false, error: err.message });
    }
  };
}

io.on('connection', (socket) => {
  // --- participante ---

  socket.on(
    'participant:join',
    safe(({ name, token }) => {
      const p = game.join(name, token);
      socket.data.role = 'participant';
      socket.data.token = p.token;
      if (!participantSockets.has(p.token)) participantSockets.set(p.token, new Set());
      participantSockets.get(p.token).add(socket.id);
      afterChange();
      return { token: p.token, name: p.name };
    })
  );

  socket.on(
    'participant:answer',
    safe(({ choice }) => {
      const token = socket.data.token;
      const answer = game.submitAnswer(token, choice, Date.now());
      if (game.opts.autoCloseWhenAllAnswered && game.allConnectedAnswered()) {
        game.closeQuestion(Date.now());
      }
      afterChange();
      return { answer: game.opts.showResultOnAnswer ? answer : null };
    })
  );

  // --- supervisor y pantalla ---

  socket.on(
    'admin:login',
    safe(({ code }) => {
      if (String(code || '') !== ADMIN_CODE) throw new Error('Código de acceso incorrecto.');
      socket.data.role = 'admin';
      socket.join('admins');
      socket.emit('admin:state', game.adminSnapshot());
    })
  );

  socket.on(
    'screen:login',
    safe(({ code }) => {
      if (String(code || '') !== ADMIN_CODE) throw new Error('Código de acceso incorrecto.');
      socket.data.role = 'screen';
      socket.join('screens');
      socket.emit('screen:state', game.screenSnapshot());
    })
  );

  const requireAdmin = () => {
    if (socket.data.role !== 'admin') throw new Error('Acción reservada al supervisor.');
  };

  socket.on(
    'admin:start_question',
    safe(({ id }) => {
      requireAdmin();
      const targetId = id || game.nextPendingId();
      if (!targetId) throw new Error('No quedan preguntas pendientes.');
      game.startQuestion(targetId, Date.now());
      afterChange();
    })
  );

  socket.on(
    'admin:close_question',
    safe(() => {
      requireAdmin();
      if (!game.closeQuestion(Date.now())) throw new Error('No hay una pregunta activa.');
      afterChange();
    })
  );

  socket.on(
    'admin:set_screen',
    safe(({ view }) => {
      requireAdmin();
      game.setScreen(view);
      afterChange();
    })
  );

  // Devolverse a una pregunta ya jugada y proyectar sus resultados.
  socket.on(
    'admin:review_question',
    safe(({ id }) => {
      requireAdmin();
      game.reviewQuestion(id);
      afterChange();
    })
  );

  // Detalle completo de una pregunta jugada: quién respondió qué, quién
  // acertó y quién falló (solo para el panel del supervisor).
  socket.on(
    'admin:question_detail',
    safe(({ id }) => {
      requireAdmin();
      const detail = game.questionRanking(id);
      if (!detail) throw new Error('La pregunta no existe.');
      return { detail };
    })
  );

  socket.on(
    'admin:sorteo',
    safe(({ questionId, category } = {}) => {
      requireAdmin();
      game.runSorteo({ questionId, category });
      afterChange();
    })
  );

  socket.on(
    'admin:reset_session',
    safe(() => {
      requireAdmin();
      game.resetSession();
      participantSockets.clear();
      io.emit('session:reset');
      afterChange();
    })
  );

  socket.on(
    'admin:remove_participant',
    safe(({ token }) => {
      requireAdmin();
      if (!game.removeParticipant(token)) throw new Error('El participante no existe.');
      const ids = participantSockets.get(token);
      if (ids) {
        for (const id of ids) io.to(id).emit('session:reset');
        participantSockets.delete(token);
      }
      afterChange();
    })
  );

  socket.on(
    'admin:question_add',
    safe(({ question }) => {
      requireAdmin();
      game.addQuestion(question);
      persistQuestions();
      afterChange();
    })
  );

  socket.on(
    'admin:question_update',
    safe(({ id, question }) => {
      requireAdmin();
      game.updateQuestion(id, question);
      persistQuestions();
      afterChange();
    })
  );

  socket.on(
    'admin:question_delete',
    safe(({ id }) => {
      requireAdmin();
      game.deleteQuestion(id);
      persistQuestions();
      afterChange();
    })
  );

  socket.on('disconnect', () => {
    const token = socket.data.token;
    if (socket.data.role === 'participant' && token) {
      const ids = participantSockets.get(token);
      if (ids) {
        ids.delete(socket.id);
        if (ids.size === 0) {
          game.setConnected(token, false);
          persistSession();
          broadcastState();
        }
      }
    }
  });
});

// Si el proceso se reinició con una pregunta abierta, retomar o cerrar según el reloj.
if (game.phase === 'question') {
  if (Date.now() >= game.deadline) {
    game.closeQuestion(Date.now());
    persistSession();
  } else {
    armQuestionTimer();
  }
}

// El banner se imprime una sola vez, con el puerto que realmente quedó en uso.
server.once('listening', () => {
  const port = server.address().port;
  const nets = os.networkInterfaces();
  const urls = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${port}/`);
    }
  }
  console.log('════════════════════════════════════════════════════════');
  console.log('  Quiz · Tema 3 Umbrales — servidor iniciado');
  console.log(`  Participantes:  http://localhost:${port}/`);
  for (const u of urls) console.log(`                  ${u}  (red local — este es el QR)`);
  console.log(`  Supervisor:     http://localhost:${port}/admin`);
  console.log(`  Pantalla:       http://localhost:${port}/pantalla`);
  console.log(`  Código de acceso (supervisor/pantalla): ${ADMIN_CODE}`);
  console.log('════════════════════════════════════════════════════════');
});

// Si el puerto está ocupado por otra aplicación, prueba con los siguientes.
function startServer(port, remainingAttempts) {
  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && remainingAttempts > 0) {
      console.warn(`⚠ El puerto ${port} está ocupado por otra aplicación; probando con el ${port + 1}…`);
      startServer(port + 1, remainingAttempts - 1);
    } else {
      console.error('No se pudo iniciar el servidor:', err.message);
      process.exit(1);
    }
  };
  server.once('error', onError);
  server.listen(port, HOST, () => server.removeListener('error', onError));
}

startServer(PORT, 20);
