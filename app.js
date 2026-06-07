import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js';
import {
  getAuth, signInWithPopup, signOut,
  GoogleAuthProvider, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import {
  getFirestore, collection, addDoc, deleteDoc,
  doc, query, orderBy, onSnapshot, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

// ── Setup check ────────────────────────────────────────────────────────────

if (firebaseConfig.apiKey === 'YOUR_API_KEY') {
  document.getElementById('setup-screen').hidden = false;
  document.getElementById('app').hidden = true;
} else {
  init();
}

// ── App ────────────────────────────────────────────────────────────────────

function init() {
  const app      = initializeApp(firebaseConfig);
  const auth     = getAuth(app);
  const db       = getFirestore(app);
  const provider = new GoogleAuthProvider();

  let unsubTasks = null;

  // Auth state
  onAuthStateChanged(auth, user => {
    document.getElementById('auth-loading').hidden = true;
    if (user) {
      showApp(user);
      subscribeTasks(db, user.uid);
    } else {
      showLogin();
      if (unsubTasks) { unsubTasks(); unsubTasks = null; }
      renderTasks([]);
    }
  });

  document.getElementById('login-btn').addEventListener('click', () => {
    signInWithPopup(auth, provider).catch(err => alert('登入失敗：' + err.message));
  });

  document.getElementById('logout-btn').addEventListener('click', () => signOut(auth));

  // Add task
  document.getElementById('add-form').addEventListener('submit', async e => {
    e.preventDefault();
    const user = auth.currentUser;
    if (!user) return;

    const title    = document.getElementById('title-input').value.trim();
    const duration = parseFloat(document.getElementById('dur-input').value);
    const unit     = document.getElementById('unit-select').value;
    if (!title || !(duration > 0)) return;

    const btn = document.getElementById('add-btn');
    btn.disabled = true;
    try {
      await addDoc(collection(db, 'users', user.uid, 'tasks'), {
        title,
        duration,
        unit,
        addedStr:  fmtDate(new Date()),
        createdAt: serverTimestamp(),
      });
      document.getElementById('title-input').value = '';
      document.getElementById('dur-input').value   = '';
      document.getElementById('title-input').focus();
    } catch (err) {
      alert('新增失敗：' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  function subscribeTasks(db, uid) {
    if (unsubTasks) unsubTasks();
    const q = query(
      collection(db, 'users', uid, 'tasks'),
      orderBy('createdAt', 'asc'),
    );
    unsubTasks = onSnapshot(q, snap => {
      renderTasks(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }, err => console.error(err));
  }

  // Exposed for inline onclick in rendered HTML
  window.__del = async (taskId) => {
    const user = auth.currentUser;
    if (!user) return;
    await deleteDoc(doc(db, 'users', user.uid, 'tasks', taskId));
  };
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function showApp(user) {
  document.getElementById('login-section').hidden = true;
  document.getElementById('user-section').hidden  = false;
  const photo = document.getElementById('user-photo');
  if (user.photoURL) photo.src = user.photoURL;
  else photo.hidden = true;
  document.getElementById('user-name').textContent = user.displayName || user.email;
  document.getElementById('add-form').hidden = false;
  document.getElementById('divider').hidden  = false;
}

function showLogin() {
  document.getElementById('login-section').hidden = false;
  document.getElementById('user-section').hidden  = true;
  document.getElementById('add-form').hidden = true;
  document.getElementById('divider').hidden  = true;
  document.getElementById('status-bar').textContent = '';
}

function toMin(duration, unit) {
  return unit === '小時' ? duration * 60 : duration;
}

function renderTasks(tasks) {
  const list   = document.getElementById('task-list');
  const status = document.getElementById('status-bar');
  list.innerHTML = '';

  if (!tasks.length) {
    list.innerHTML = '<p class="empty-msg">沒有待辦事項 ✓</p>';
    status.textContent = '目前沒有任何待辦事項';
    return;
  }

  const mins   = tasks.map(t => toMin(t.duration, t.unit));
  const maxMin = Math.max(...mins, 1);

  tasks.forEach((task, i) => {
    const pct = Math.max(3, Math.round((mins[i] / maxMin) * 100));
    const card = document.createElement('div');
    card.className = 'task-card';
    card.innerHTML = `
      <div class="task-top">
        <span class="task-title">${esc(task.title)}</span>
        <button class="done-btn" onclick="__del('${task.id}')">完成 ✓</button>
      </div>
      <div class="task-meta">⏱ ${esc(String(+task.duration.toPrecision(4)))} ${esc(task.unit)} · 新增於 ${esc(task.addedStr || '')}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
    `;
    list.appendChild(card);
  });

  const total   = mins.reduce((a, b) => a + b, 0);
  const timeStr = total >= 60
    ? `${+(total / 60).toPrecision(3)} 小時`
    : `${+total.toPrecision(3)} 分鐘`;
  status.textContent = `共 ${tasks.length} 項任務 · 預估總時間 ${timeStr}`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── Service worker ─────────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
