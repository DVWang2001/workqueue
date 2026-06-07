import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js';
import {
  getAuth, signInWithPopup, signOut,
  GoogleAuthProvider, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import {
  getFirestore, collection, addDoc, deleteDoc, updateDoc,
  doc, query, orderBy, onSnapshot, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

// ── Config check ────────────────────────────────────────────────────────────
if (firebaseConfig.apiKey === 'YOUR_API_KEY') {
  document.getElementById('setup-screen').hidden = false;
  document.getElementById('app').hidden = true;
} else {
  init();
}

// ── Module-level state ─────────────────────────────────────────────────────
let auth, db;
let unsubTasks = null;
let unsubNotes = null;
let currentNoteId = null;
let saveTimer = null;

// ── App init ───────────────────────────────────────────────────────────────
function init() {
  const app      = initializeApp(firebaseConfig);
  auth           = getAuth(app);
  db             = getFirestore(app);
  const provider = new GoogleAuthProvider();

  // Auth state
  onAuthStateChanged(auth, user => {
    document.getElementById('auth-loading').hidden = true;
    if (user) {
      showApp(user);
    } else {
      showLogin();
      if (unsubTasks) { unsubTasks(); unsubTasks = null; }
      if (unsubNotes) { unsubNotes(); unsubNotes = null; }
      renderTasks([]);
      renderNotesList([]);
    }
  });

  // Auth buttons
  document.getElementById('login-btn').addEventListener('click', () =>
    signInWithPopup(auth, provider).catch(err => alert('登入失敗：' + err.message))
  );
  document.getElementById('logout-btn').addEventListener('click', () => signOut(auth));

  // Task form
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
        title, duration, unit,
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

  // Nav tabs
  document.querySelectorAll('.nav-tab').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );

  // Notes buttons
  document.getElementById('new-note-btn').addEventListener('click', createNote);
  document.getElementById('back-to-notes').addEventListener('click', () => closeEditor());
  document.getElementById('delete-note-btn').addEventListener('click', deleteCurrentNote);
  document.getElementById('edit-mode-btn').addEventListener('click', () => setEditorMode('edit'));
  document.getElementById('preview-mode-btn').addEventListener('click', () => setEditorMode('preview'));

  // Auto-save
  document.getElementById('note-title').addEventListener('input', scheduleSave);
  document.getElementById('note-content').addEventListener('input', scheduleSave);

  // Keyboard shortcuts in textarea
  document.getElementById('note-content').addEventListener('keydown', handleEditorKey);

  // Build toolbar
  setupToolbar();
}

// ── Auth UI ────────────────────────────────────────────────────────────────
function showApp(user) {
  document.getElementById('login-section').hidden = true;
  document.getElementById('user-section').hidden  = false;
  const photo = document.getElementById('user-photo');
  if (user.photoURL) photo.src = user.photoURL; else photo.hidden = true;
  document.getElementById('user-name').textContent = user.displayName || user.email;
  document.getElementById('add-form').hidden  = false;
  document.getElementById('divider').hidden   = false;
  document.getElementById('main-nav').hidden  = false;
  subscribeToTasks(user.uid);
  subscribeToNotes(user.uid);
}

function showLogin() {
  document.getElementById('login-section').hidden = false;
  document.getElementById('user-section').hidden  = true;
  document.getElementById('add-form').hidden  = true;
  document.getElementById('divider').hidden   = true;
  document.getElementById('main-nav').hidden  = true;
  document.getElementById('status-bar').textContent = '';
}

// ── Tab navigation ─────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.nav-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.getElementById('tasks-view').hidden = tab !== 'tasks';
  document.getElementById('notes-view').hidden = tab !== 'notes';
  document.getElementById('status-bar').hidden = tab !== 'tasks';
}

// ── Tasks ──────────────────────────────────────────────────────────────────
function subscribeToTasks(uid) {
  if (unsubTasks) unsubTasks();
  const q = query(collection(db, 'users', uid, 'tasks'), orderBy('createdAt', 'asc'));
  unsubTasks = onSnapshot(q, snap =>
    renderTasks(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => console.error(err)
  );
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
    const pct  = Math.max(3, Math.round((mins[i] / maxMin) * 100));
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

window.__del = async taskId => {
  const user = auth.currentUser;
  if (!user) return;
  await deleteDoc(doc(db, 'users', user.uid, 'tasks', taskId));
};

// ── Notes list ─────────────────────────────────────────────────────────────
function subscribeToNotes(uid) {
  if (unsubNotes) unsubNotes();
  const q = query(collection(db, 'users', uid, 'notes'), orderBy('updatedAt', 'desc'));
  unsubNotes = onSnapshot(q, snap =>
    renderNotesList(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => console.error(err)
  );
}

function renderNotesList(notes) {
  const list = document.getElementById('notes-list');
  document.getElementById('notes-count').textContent =
    notes.length ? `${notes.length} 則筆記` : '';
  list.innerHTML = '';

  if (!notes.length) {
    list.innerHTML = '<p class="empty-msg">沒有筆記，點「＋ 新增筆記」開始。</p>';
    return;
  }

  notes.forEach(note => {
    const title   = note.title || '無標題';
    const preview = stripMd(note.content || '').slice(0, 100);
    const date    = note.updatedAt?.toDate ? fmtDate(note.updatedAt.toDate()) : '';
    const card    = document.createElement('div');
    card.className = 'note-card';
    card.innerHTML = `
      <div class="note-card-title">${esc(title)}</div>
      ${preview ? `<div class="note-card-preview">${esc(preview)}</div>` : ''}
      <div class="note-card-date">${esc(date)}</div>
    `;
    card.addEventListener('click', () => openNote(note));
    list.appendChild(card);
  });
}

// ── Note editor ────────────────────────────────────────────────────────────
async function createNote() {
  const user = auth.currentUser;
  if (!user) return;
  const ref = await addDoc(collection(db, 'users', user.uid, 'notes'), {
    title: '', content: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  openNote({ id: ref.id, title: '', content: '' });
}

function openNote(note) {
  currentNoteId = note.id;
  document.getElementById('note-title').value   = note.title   || '';
  document.getElementById('note-content').value = note.content || '';
  document.getElementById('editor-status').textContent = '';
  document.getElementById('notes-list-pane').hidden = true;
  document.getElementById('editor-pane').hidden     = false;
  setEditorMode('edit');
  // Focus title if empty, else content
  const target = note.title ? 'note-content' : 'note-title';
  document.getElementById(target).focus();
}

async function closeEditor() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (currentNoteId && auth.currentUser) {
    const title   = document.getElementById('note-title').value.trim();
    const content = document.getElementById('note-content').value.trim();
    if (!title && !content) {
      // Empty note — delete it silently
      await deleteDoc(doc(db, 'users', auth.currentUser.uid, 'notes', currentNoteId));
    } else {
      await doSave();
    }
  }
  currentNoteId = null;
  document.getElementById('editor-pane').hidden     = true;
  document.getElementById('notes-list-pane').hidden = false;
}

async function deleteCurrentNote() {
  if (!currentNoteId || !auth.currentUser) return;
  if (!confirm('確定要刪除這則筆記嗎？')) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await deleteDoc(doc(db, 'users', auth.currentUser.uid, 'notes', currentNoteId));
  currentNoteId = null;
  document.getElementById('editor-pane').hidden     = true;
  document.getElementById('notes-list-pane').hidden = false;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  document.getElementById('editor-status').textContent = '未儲存…';
  saveTimer = setTimeout(doSave, 1500);
}

async function doSave() {
  saveTimer = null;
  if (!currentNoteId || !auth.currentUser) return;
  const title   = document.getElementById('note-title').value.trim();
  const content = document.getElementById('note-content').value;
  try {
    await updateDoc(doc(db, 'users', auth.currentUser.uid, 'notes', currentNoteId), {
      title: title || '無標題',
      content,
      updatedAt: serverTimestamp(),
    });
    document.getElementById('editor-status').textContent = '已儲存';
  } catch (err) {
    document.getElementById('editor-status').textContent = '儲存失敗';
    console.error(err);
  }
}

function setEditorMode(mode) {
  const isEdit = mode === 'edit';
  document.getElementById('note-content').hidden  = !isEdit;
  document.getElementById('note-preview').hidden  = isEdit;
  document.getElementById('edit-mode-btn').classList.toggle('active', isEdit);
  document.getElementById('preview-mode-btn').classList.toggle('active', !isEdit);

  if (!isEdit) {
    const raw  = document.getElementById('note-content').value;
    const html = DOMPurify.sanitize(
      window.marked.parse(raw, { gfm: true, breaks: true }),
      { ADD_TAGS: ['input'], ADD_ATTR: ['type', 'checked', 'disabled'] }
    );
    const preview = document.getElementById('note-preview');
    preview.innerHTML = html;
    preview.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.disabled = true; });
  }
}

// ── Markdown toolbar ───────────────────────────────────────────────────────
function setupToolbar() {
  const bar = document.getElementById('md-toolbar');

  const groups = [
    [
      { label: 'H1',   title: '標題 1',     fn: () => insertLine('# ') },
      { label: 'H2',   title: '標題 2',     fn: () => insertLine('## ') },
      { label: 'H3',   title: '標題 3',     fn: () => insertLine('### ') },
    ],
    [
      { label: 'B',    title: '粗體 Ctrl+B', fn: () => wrap('**', '**') },
      { label: 'I',    title: '斜體 Ctrl+I', fn: () => wrap('*',  '*'),  italic: true },
      { label: 'S',    title: '刪除線',      fn: () => wrap('~~', '~~') },
    ],
    [
      { label: '❝',    title: '引用',        fn: () => insertLine('> ') },
      { label: '`',    title: '行內程式碼',  fn: () => wrap('`',  '`') },
      { label: '</>',  title: '程式碼區塊',  fn: () => wrapBlock() },
    ],
    [
      { label: '•',    title: '項目清單',    fn: () => insertLine('- ') },
      { label: '1.',   title: '編號清單',    fn: () => insertLine('1. ') },
      { label: '☐',   title: '待辦項目',    fn: () => insertLine('- [ ] ') },
    ],
    [
      { label: '🔗',   title: '插入連結',    fn: () => insertLink() },
      { label: '—',   title: '分隔線',      fn: () => insertHR() },
    ],
  ];

  groups.forEach((group, gi) => {
    if (gi > 0) {
      const sep = document.createElement('span');
      sep.className = 'tb-sep';
      bar.appendChild(sep);
    }
    group.forEach(({ label, title, fn, italic }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tb-btn';
      btn.textContent = label;
      btn.title = title;
      if (italic) btn.dataset.type = 'italic';
      btn.addEventListener('click', fn);
      bar.appendChild(btn);
    });
  });
}

// ── Editor text manipulation ───────────────────────────────────────────────
const ta = () => document.getElementById('note-content');

function wrap(before, after) {
  const el = ta(), s = el.selectionStart, e = el.selectionEnd;
  const sel = el.value.slice(s, e);
  el.value = el.value.slice(0, s) + before + sel + after + el.value.slice(e);
  el.selectionStart = s + before.length;
  el.selectionEnd   = s + before.length + sel.length;
  el.focus(); scheduleSave();
}

function insertLine(prefix) {
  const el = ta(), s = el.selectionStart;
  const ls = el.value.lastIndexOf('\n', s - 1) + 1;
  el.value = el.value.slice(0, ls) + prefix + el.value.slice(ls);
  el.selectionStart = el.selectionEnd = s + prefix.length;
  el.focus(); scheduleSave();
}

function wrapBlock() {
  const el = ta(), s = el.selectionStart, e = el.selectionEnd;
  const sel = el.value.slice(s, e);
  const before = '```\n', after = '\n```';
  el.value = el.value.slice(0, s) + before + sel + after + el.value.slice(e);
  el.selectionStart = s + before.length;
  el.selectionEnd   = s + before.length + sel.length;
  el.focus(); scheduleSave();
}

function insertLink() {
  const el = ta(), s = el.selectionStart, e = el.selectionEnd;
  const sel = el.value.slice(s, e);
  const text = sel || '連結文字';
  const rep  = `[${text}](url)`;
  el.value = el.value.slice(0, s) + rep + el.value.slice(e);
  const us = s + text.length + 3;
  el.selectionStart = us; el.selectionEnd = us + 3;
  el.focus(); scheduleSave();
}

function insertHR() {
  const el = ta(), s = el.selectionStart;
  const hr = '\n\n---\n\n';
  el.value = el.value.slice(0, s) + hr + el.value.slice(s);
  el.selectionStart = el.selectionEnd = s + hr.length;
  el.focus(); scheduleSave();
}

function handleEditorKey(e) {
  const el = e.target;
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = el.selectionStart, end = el.selectionEnd;
    el.value = el.value.slice(0, s) + '  ' + el.value.slice(end);
    el.selectionStart = el.selectionEnd = s + 2;
    scheduleSave();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'b') { e.preventDefault(); wrap('**', '**'); }
    if (e.key === 'i') { e.preventDefault(); wrap('*', '*'); }
    if (e.key === 's') { e.preventDefault(); doSave(); }
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────
function toMin(duration, unit) { return unit === '小時' ? duration * 60 : duration; }

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function stripMd(s) {
  return s
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*|__|\*|_|~~|`{1,3}/g, '')
    .replace(/^[-*>\d]+[.)]\s/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n+/g, ' ')
    .trim();
}

// ── Service worker ─────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
