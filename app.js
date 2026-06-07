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

// ── Module-level state ─────────────────────────────────────────────────────
let auth, db;
let quill = null;
let unsubTasks = null;
let unsubNotes = null;
let currentNoteId = null;
let saveTimer = null;

// ── Config check ────────────────────────────────────────────────────────────
if (firebaseConfig.apiKey === 'YOUR_API_KEY') {
  document.getElementById('setup-screen').hidden = false;
  document.getElementById('app').hidden = true;
} else {
  init();
}

// Quill toolbar — matches Blogspot editor feature set
const TOOLBAR = [
  [{ header: [1, 2, 3, 4, false] }],
  [{ font: [] }],
  [{ size: ['small', false, 'large', 'huge'] }],
  ['bold', 'italic', 'underline', 'strike'],
  [{ color: [] }, { background: [] }],
  [{ align: [] }],
  [{ list: 'ordered' }, { list: 'bullet' }],
  [{ indent: '-1' }, { indent: '+1' }],
  ['blockquote', 'code-block'],
  ['link', 'image'],
  ['clean'],
];

// ── Init ───────────────────────────────────────────────────────────────────
function init() {
  const app      = initializeApp(firebaseConfig);
  auth           = getAuth(app);
  db             = getFirestore(app);
  const provider = new GoogleAuthProvider();

  // Initialize Quill editor
  quill = new Quill('#quill-editor', {
    theme: 'snow',
    modules: { toolbar: TOOLBAR },
    placeholder: '開始寫備忘錄…',
  });

  // Custom image handler — insert by URL (avoids large base64 in Firestore)
  quill.getModule('toolbar').addHandler('image', () => {
    const url = prompt('請輸入圖片網址（URL）：');
    if (url && url.trim()) {
      const range = quill.getSelection() ?? { index: quill.getLength() };
      quill.insertEmbed(range.index, 'image', url.trim(), 'user');
    }
  });

  // Auto-save on content change
  quill.on('text-change', scheduleSave);

  // Ctrl+S / Cmd+S to save
  document.getElementById('quill-editor').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); doSave(); }
  });

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
  document.getElementById('share-note-btn').addEventListener('click', openShareModal);

  // Share modal
  document.getElementById('share-backdrop').addEventListener('click', closeShareModal);
  document.getElementById('share-close').addEventListener('click', closeShareModal);
  document.querySelectorAll('.share-btn').forEach(btn =>
    btn.addEventListener('click', () => handleShare(btn.dataset.platform))
  );

  // Auto-save on title change
  document.getElementById('note-title').addEventListener('input', scheduleSave);
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
  unsubTasks = onSnapshot(q,
    snap => renderTasks(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err  => console.error(err)
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
  const timeStr = total >= 60 ? `${+(total/60).toPrecision(3)} 小時` : `${+total.toPrecision(3)} 分鐘`;
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
  unsubNotes = onSnapshot(q,
    snap => renderNotesList(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err  => console.error(err)
  );
}

function renderNotesList(notes) {
  const list = document.getElementById('notes-list');
  document.getElementById('notes-count').textContent = notes.length ? `${notes.length} 則筆記` : '';
  list.innerHTML = '';

  if (!notes.length) {
    list.innerHTML = '<p class="empty-msg">沒有筆記，點「＋ 新增筆記」開始。</p>';
    return;
  }

  notes.forEach(note => {
    const title   = note.title || '無標題';
    const preview = htmlToPlain(note.content || '').slice(0, 100);
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
    title: '', content: '', contentType: 'html',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  openNote({ id: ref.id, title: '', content: '', contentType: 'html' });
}

function openNote(note) {
  currentNoteId = note.id;
  document.getElementById('note-title').value = note.title || '';
  document.getElementById('editor-status').textContent = '';

  // Load content into Quill
  // Old notes (Markdown) are detected by absence of contentType field
  let html = note.content || '';
  if (html && note.contentType !== 'html') {
    // Convert legacy Markdown to HTML
    html = window.marked.parse(html, { gfm: true, breaks: true });
  }
  quill.root.innerHTML = DOMPurify.sanitize(html, {
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['allowfullscreen', 'frameborder', 'src'],
  });

  document.getElementById('notes-list-pane').hidden = true;
  document.getElementById('editor-pane').hidden     = false;

  // Focus appropriately
  setTimeout(() => {
    if (!note.title) document.getElementById('note-title').focus();
    else { quill.focus(); quill.setSelection(quill.getLength(), 0); }
  }, 50);
}

async function closeEditor() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (currentNoteId && auth.currentUser) {
    const title   = document.getElementById('note-title').value.trim();
    const content = quill.root.innerHTML;
    const isEmpty = !title && isQuillEmpty(content);
    if (isEmpty) {
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
  const content = quill.root.innerHTML;
  try {
    await updateDoc(doc(db, 'users', auth.currentUser.uid, 'notes', currentNoteId), {
      title: title || '無標題',
      content,
      contentType: 'html',
      updatedAt: serverTimestamp(),
    });
    document.getElementById('editor-status').textContent = '已儲存';
  } catch (err) {
    document.getElementById('editor-status').textContent = '儲存失敗';
    console.error(err);
  }
}

// ── Share ──────────────────────────────────────────────────────────────────
function openShareModal() {
  // Hide native share button if browser doesn't support it
  const nativeBtn = document.querySelector('[data-platform="native"]');
  if (nativeBtn) nativeBtn.style.display = navigator.share ? '' : 'none';
  document.getElementById('share-modal').hidden = false;
}

function closeShareModal() {
  document.getElementById('share-modal').hidden = true;
}

async function handleShare(platform) {
  const title  = document.getElementById('note-title').value.trim() || '備忘錄';
  const html   = quill.root.innerHTML;
  const plain  = htmlToPlain(html);
  const full   = title + (plain ? '\n\n' + plain : '');

  switch (platform) {
    case 'copy':
      await copyToClipboard(plain);
      showToast('已複製文字到剪貼簿');
      break;

    case 'threads':
      openUrl('https://www.threads.net/intent/post?text=' + enc(full.slice(0, 500)));
      break;

    case 'twitter':
      openUrl('https://x.com/intent/post?text=' + enc(full.slice(0, 270)));
      break;

    case 'facebook':
      await copyToClipboard(full);
      openUrl('https://www.facebook.com/');
      showToast('已複製內容，請在 Facebook 建立貼文後貼上');
      break;

    case 'blogger':
      await copyToClipboard(html);
      openUrl('https://www.blogger.com/blog/post/create');
      showToast('已複製 HTML，請在 Blogger 切換到 HTML 模式後貼上');
      break;

    case 'line':
      openUrl('https://line.me/R/msg/text/?' + enc(full.slice(0, 500)));
      break;

    case 'native':
      if (!navigator.share) { showToast('您的瀏覽器不支援系統分享'); break; }
      try { await navigator.share({ title, text: plain }); }
      catch (e) { if (e.name !== 'AbortError') showToast('分享失敗'); }
      break;
  }

  closeShareModal();
}

function openUrl(url) { window.open(url, '_blank', 'noopener'); }
function enc(s) { return encodeURIComponent(s); }

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select(); document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

// ── Utilities ──────────────────────────────────────────────────────────────
function isQuillEmpty(html) {
  return !html || html === '<p><br></p>' || html === '<p></p>';
}

function htmlToPlain(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim();
}

function toMin(duration, unit) { return unit === '小時' ? duration * 60 : duration; }

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── Service worker ─────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
