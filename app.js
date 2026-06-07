import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js';
import {
  getAuth, signInWithPopup, signOut,
  GoogleAuthProvider, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import {
  getFirestore, collection, addDoc, deleteDoc, updateDoc, setDoc,
  doc, query, orderBy, onSnapshot, serverTimestamp, getDoc,
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

// ── Module-level state ─────────────────────────────────────────────────────
let auth, db;
let quill = null;
let unsubTasks = null;
let unsubNotes = null;
let unsubExpenses = null;
let unsubDailyTemplates = null;
let unsubTodayRecord    = null;
let expenseChart = null;
let currentNoteId = null;
let saveTimer = null;
let dailyTemplatesData = [];
let todayRecordData    = null;
let streakData         = { streak: 0, longest: 0, lastCheck: '', days: [] };
let lastKnownDateUTC8  = '';
let dailyDayCheckTimer = null;
let _vvFixCleanup      = null;

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

// ── Config check ────────────────────────────────────────────────────────────
if (firebaseConfig.apiKey === 'YOUR_API_KEY') {
  document.getElementById('setup-screen').hidden = false;
  document.getElementById('app').hidden = true;
} else {
  init();
}

initPullToRefresh();

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

  // Move toolbar out of #editor-scroll so the keyboard can't push it away.
  // It becomes a flex-shrink:0 child of #editor-pane, always visible above
  // the scroll area regardless of keyboard / viewport changes.
  {
    const editorPane   = document.getElementById('editor-pane');
    const editorScroll = document.getElementById('editor-scroll');
    const toolbar      = editorPane.querySelector('.ql-toolbar');
    if (toolbar && editorScroll) editorPane.insertBefore(toolbar, editorScroll);
  }

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
      if (unsubTasks)    { unsubTasks();    unsubTasks    = null; }
      if (unsubNotes)    { unsubNotes();    unsubNotes    = null; }
      if (unsubExpenses) { unsubExpenses(); unsubExpenses = null; }
      renderTasks([]);
      renderNotesList([]);
      renderExpenseList([]);
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

  // Voice input — task
  document.getElementById('task-voice-btn').addEventListener('click', () => {
    startVoice(document.getElementById('task-voice-btn'), text => {
      document.getElementById('title-input').value = text;
      document.getElementById('title-input').focus();
    });
  });

  // Expense form
  document.getElementById('expense-form').addEventListener('submit', async e => {
    e.preventDefault();
    const user = auth.currentUser;
    if (!user) return;
    const desc   = document.getElementById('expense-desc').value.trim();
    const amount = parseFloat(document.getElementById('expense-amount').value);
    const date   = document.getElementById('expense-date').value;
    if (!desc || !(amount > 0) || !date) return;
    const btn = document.getElementById('expense-add-btn');
    btn.disabled = true;
    try {
      await addDoc(collection(db, 'users', user.uid, 'expenses'), {
        desc, amount, date, createdAt: serverTimestamp(),
      });
      document.getElementById('expense-desc').value   = '';
      document.getElementById('expense-amount').value = '';
      document.getElementById('expense-desc').focus();
    } catch (err) {
      alert('新增失敗：' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // Voice input — expense
  document.getElementById('expense-voice-btn').addEventListener('click', () => {
    startVoice(document.getElementById('expense-voice-btn'), text => {
      document.getElementById('expense-desc').value = text;
      document.getElementById('expense-amount').focus();
    });
  });

  // Voice input — note
  document.getElementById('note-voice-btn').addEventListener('click', () => {
    startVoice(document.getElementById('note-voice-btn'), text => {
      const range = quill.getSelection() ?? { index: quill.getLength() };
      quill.insertText(range.index, text, 'user');
      quill.setSelection(range.index + text.length);
    });
  });

  // Daily must-do form
  document.getElementById('daily-form').addEventListener('submit', async e => {
    e.preventDefault();
    const user = auth.currentUser;
    if (!user) return;
    const title = document.getElementById('daily-input').value.trim();
    if (!title) return;
    const btn = document.getElementById('daily-add-btn');
    btn.disabled = true;
    try {
      await addDoc(collection(db, 'users', user.uid, 'dailyTemplates'), {
        title, createdAt: serverTimestamp(),
      });
      document.getElementById('daily-input').value = '';
      document.getElementById('daily-input').focus();
    } catch (err) {
      alert('新增失敗：' + err.message);
    } finally {
      btn.disabled = false;
    }
  });
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
  document.getElementById('expense-date').value = new Date().toISOString().slice(0, 10);
  subscribeToTasks(user.uid);
  subscribeToNotes(user.uid);
  subscribeToExpenses(user.uid);
  lastKnownDateUTC8 = getTodayUTC8();
  subscribeToDailyTemplates(user.uid);
  subscribeToTodayRecord(user.uid);
  checkAndUpdateStreak(user.uid).catch(console.error);
  if (!dailyDayCheckTimer) {
    dailyDayCheckTimer = setInterval(() => {
      const now = getTodayUTC8();
      if (now !== lastKnownDateUTC8) {
        lastKnownDateUTC8 = now;
        if (auth.currentUser) {
          subscribeToTodayRecord(auth.currentUser.uid);
          checkAndUpdateStreak(auth.currentUser.uid).catch(console.error);
        }
      }
    }, 60000);
  }
}

function showLogin() {
  document.getElementById('login-section').hidden = false;
  document.getElementById('user-section').hidden  = true;
  document.getElementById('add-form').hidden  = true;
  document.getElementById('divider').hidden   = true;
  document.getElementById('main-nav').hidden  = true;
  document.getElementById('status-bar').textContent = '';
  if (unsubDailyTemplates) { unsubDailyTemplates(); unsubDailyTemplates = null; }
  if (unsubTodayRecord)    { unsubTodayRecord();    unsubTodayRecord    = null; }
  if (dailyDayCheckTimer)  { clearInterval(dailyDayCheckTimer); dailyDayCheckTimer = null; }
  dailyTemplatesData = [];
  todayRecordData    = null;
  streakData         = { streak: 0, longest: 0, lastCheck: '', days: [] };
  renderDailyPinnedItems();
  renderDailyTemplateList([]);
  renderStreakBanner();
}

// ── Tab navigation ─────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.nav-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.getElementById('tasks-view').hidden  = tab !== 'tasks';
  document.getElementById('daily-view').hidden  = tab !== 'daily';
  document.getElementById('notes-view').hidden  = tab !== 'notes';
  document.getElementById('ledger-view').hidden = tab !== 'ledger';
  document.getElementById('status-bar').hidden  = tab !== 'tasks';
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

function startEditorVVFix() {
  stopEditorVVFix();
  const vv = window.visualViewport;
  if (!vv) return;
  const editorPane = document.getElementById('editor-pane');
  function update() {
    if (!editorPane) return;
    const offsetTop = vv.offsetTop || 0;
    // Counteract iOS layout-viewport scroll so toolbar stays on screen
    editorPane.style.transform = offsetTop ? `translateY(${offsetTop}px)` : '';
    // Constrain height to visual viewport so #editor-scroll scrolls cursor above keyboard
    editorPane.style.height = offsetTop ? `${vv.height}px` : '';
  }
  vv.addEventListener('scroll', update);
  vv.addEventListener('resize', update);
  _vvFixCleanup = () => {
    vv.removeEventListener('scroll', update);
    vv.removeEventListener('resize', update);
    if (editorPane) { editorPane.style.transform = ''; editorPane.style.height = ''; }
  };
}

function stopEditorVVFix() {
  if (_vvFixCleanup) { _vvFixCleanup(); _vvFixCleanup = null; }
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
  startEditorVVFix();

  // Focus appropriately
  setTimeout(() => {
    if (!note.title) document.getElementById('note-title').focus();
    else { quill.focus(); quill.setSelection(quill.getLength(), 0); }
  }, 50);
}

async function closeEditor() {
  stopEditorVVFix();
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
  stopEditorVVFix();
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
      openUrl('https://www.facebook.com/');
      await copyToClipboard(full);
      showToast('已複製內容，請在 Facebook 建立貼文後貼上');
      break;

    case 'blogger':
      openUrl('https://www.blogger.com/blog/post/create');
      await copyToClipboard(html);
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

// ── Expenses ───────────────────────────────────────────────────────────────
function subscribeToExpenses(uid) {
  if (unsubExpenses) unsubExpenses();
  const q = query(collection(db, 'users', uid, 'expenses'), orderBy('createdAt', 'desc'));
  unsubExpenses = onSnapshot(q,
    snap => {
      const expenses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderExpenseList(expenses);
      renderChart(expenses);
    },
    err => console.error(err)
  );
}

function renderExpenseList(expenses) {
  const list = document.getElementById('expense-list');
  list.innerHTML = '';
  if (!expenses.length) {
    list.innerHTML = '<p class="empty-msg">沒有支出記錄，新增第一筆吧！</p>';
    return;
  }
  const sorted = [...expenses].sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
  sorted.forEach(exp => {
    const card = document.createElement('div');
    card.className = 'expense-card';
    card.innerHTML = `
      <div class="expense-left">
        <span class="expense-date">${esc(exp.date || '')}</span>
        <span class="expense-desc">${esc(exp.desc || '')}</span>
      </div>
      <div class="expense-right">
        <span class="expense-amount">$${Number(exp.amount || 0).toLocaleString()}</span>
        <button class="expense-del-btn" onclick="__delExp('${exp.id}')">✕</button>
      </div>
    `;
    list.appendChild(card);
  });
}

function renderChart(expenses) {
  const map = {};
  expenses.forEach(e => {
    if (!e.date) return;
    const month = e.date.slice(0, 7);
    map[month] = (map[month] || 0) + (e.amount || 0);
  });

  const months = Object.keys(map).sort();
  const totals = months.map(m => map[m]);
  const total  = totals.reduce((a, b) => a + b, 0);
  const avg    = totals.length ? Math.round(total / totals.length) : 0;

  const summaryEl = document.getElementById('ledger-summary');
  const chartWrap = document.getElementById('chart-wrap');

  if (!months.length) {
    summaryEl.hidden = true;
    chartWrap.hidden = true;
    if (expenseChart) { expenseChart.destroy(); expenseChart = null; }
    return;
  }

  summaryEl.hidden = false;
  chartWrap.hidden = false;
  document.getElementById('ledger-avg').textContent =
    `月平均花費：$${avg.toLocaleString()}　　累計總支出：$${Math.round(total).toLocaleString()}`;

  const labels = months.map(m => {
    const [y, mo] = m.split('-');
    return `${y}年${parseInt(mo)}月`;
  });

  const ctx = document.getElementById('expense-chart').getContext('2d');
  if (expenseChart) expenseChart.destroy();

  expenseChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '月支出',
          data: totals,
          borderColor: '#4a6cf7',
          backgroundColor: 'rgba(74,108,247,0.12)',
          tension: 0.35,
          fill: true,
          pointBackgroundColor: '#4a6cf7',
          pointRadius: 5,
          pointHoverRadius: 7,
        },
        {
          label: `月平均 $${avg.toLocaleString()}`,
          data: months.map(() => avg),
          borderColor: '#f59e0b',
          borderDash: [6, 3],
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { color: '#50507a', font: { size: 12 } } },
        tooltip: { callbacks: { label: c => `$${Math.round(c.parsed.y).toLocaleString()}` } },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: v => '$' + Math.round(v).toLocaleString(), color: '#50507a' },
          grid: { color: '#dcdcec' },
        },
        x: { ticks: { color: '#50507a' }, grid: { color: '#dcdcec' } },
      },
    },
  });
}

window.__delExp = async id => {
  const user = auth.currentUser;
  if (!user) return;
  await deleteDoc(doc(db, 'users', user.uid, 'expenses', id));
};

// ── Voice Input ────────────────────────────────────────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function startVoice(btn, onResult) {
  if (!SR) { showToast('您的瀏覽器不支援語音輸入（建議使用 Chrome 或 Edge）'); return; }
  const rec = new SR();
  rec.lang = 'zh-TW';
  rec.interimResults = false;
  rec.maxAlternatives = 1;

  btn.classList.add('voice-recording');

  rec.onresult = e => {
    onResult(e.results[0][0].transcript);
  };
  rec.onerror = () => {
    showToast('語音辨識失敗，請再試一次');
  };
  rec.onend = () => {
    btn.classList.remove('voice-recording');
  };
  rec.start();
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

// ── Daily Must-Do ──────────────────────────────────────────────────────────

function getTodayUTC8() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

function subscribeToDailyTemplates(uid) {
  if (unsubDailyTemplates) unsubDailyTemplates();
  const q = query(collection(db, 'users', uid, 'dailyTemplates'), orderBy('createdAt', 'asc'));
  unsubDailyTemplates = onSnapshot(q, snap => {
    dailyTemplatesData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderDailyTemplateList(dailyTemplatesData);
    if (dailyTemplatesData.length) ensureTodayRecord(uid, dailyTemplatesData).catch(console.error);
  }, console.error);
}

function subscribeToTodayRecord(uid) {
  if (unsubTodayRecord) unsubTodayRecord();
  const today = getTodayUTC8();
  unsubTodayRecord = onSnapshot(
    doc(db, 'users', uid, 'dailyRecords', today),
    snap => {
      todayRecordData = snap.exists() ? snap.data() : null;
      renderDailyPinnedItems();
      renderStreakBanner();
    },
    console.error
  );
}

async function ensureTodayRecord(uid, templates) {
  const today = getTodayUTC8();
  const ref   = doc(db, 'users', uid, 'dailyRecords', today);
  const snap  = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      date:    today,
      items:   templates.map(t => ({ id: t.id, title: t.title, done: false })),
      allDone: false,
    });
  } else {
    const record       = snap.data();
    const existingIds  = new Set(record.items.map(i => i.id));
    const newItems     = templates.filter(t => !existingIds.has(t.id));
    if (newItems.length) {
      await updateDoc(ref, {
        items: [
          ...record.items,
          ...newItems.map(t => ({ id: t.id, title: t.title, done: false })),
        ],
      });
    }
  }
}

async function checkAndUpdateStreak(uid) {
  const today    = getTodayUTC8();
  const streakRef = doc(db, 'users', uid, 'dailyMeta', 'streak');
  const snap     = await getDoc(streakRef);
  let data       = snap.exists()
    ? snap.data()
    : { streak: 0, longest: 0, lastCheck: '', days: [] };

  if (data.lastCheck >= today) {
    streakData = data;
    renderStreakBanner();
    return;
  }

  const yesterday = new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);

  if (!data.lastCheck || data.lastCheck >= yesterday) {
    const updated = { ...data, lastCheck: today };
    await setDoc(streakRef, updated);
    streakData = updated;
    renderStreakBanner();
    return;
  }

  // Build date list: from (lastCheck + 1 day) to yesterday inclusive
  const dates = [];
  let cur = new Date(data.lastCheck + 'T00:00:00Z');
  cur = new Date(cur.getTime() + 86400000);
  const end = new Date(yesterday + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 86400000);
  }

  let { streak, longest, days } = data;
  for (const dateStr of dates) {
    const recSnap = await getDoc(doc(db, 'users', uid, 'dailyRecords', dateStr));
    if (recSnap.exists()) {
      const rec = recSnap.data();
      if (rec.items && rec.items.length > 0) {
        const done = !!rec.allDone;
        streak  = done ? streak + 1 : 0;
        longest = Math.max(longest, streak);
        days    = [...(days || []).filter(d => d.date !== dateStr), { date: dateStr, done }];
      }
    }
  }

  days = (days || []).sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  const updated = { streak, longest, lastCheck: today, days };
  await setDoc(streakRef, updated);
  streakData = updated;
  renderStreakBanner();
}

function renderStreakBanner() {
  const el = document.getElementById('streak-banner');
  if (!el) return;

  const { streak, longest, days } = streakData;
  const today   = getTodayUTC8();
  const daysMap = Object.fromEntries((days || []).map(d => [d.date, d.done]));

  const last7 = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.now() + 8 * 3600000 - (6 - i) * 86400000).toISOString().slice(0, 10)
  );

  const dots = last7.map(date => {
    if (date === today) {
      const total   = todayRecordData?.items?.length || 0;
      const doneN   = total ? todayRecordData.items.filter(i => i.done).length : 0;
      const allDone = todayRecordData?.allDone;
      const label   = total ? `${doneN}/${total}` : '–';
      return `<div class="streak-dot ${allDone ? 'sdone' : 'stoday'}" title="${date}">${allDone ? '✓' : label}</div>`;
    }
    const val = daysMap[date];
    if (val === true)  return `<div class="streak-dot sdone"  title="${date}">✓</div>`;
    if (val === false) return `<div class="streak-dot smiss"  title="${date}">✗</div>`;
    return `<div class="streak-dot sempty" title="${date}">–</div>`;
  }).join('');

  const fire = streak >= 7 ? '🔥' : streak >= 3 ? '⭕' : streak > 0 ? '✨' : '💤';

  el.innerHTML = `
    <div class="streak-card">
      <div class="streak-main">
        <span class="streak-fire">${fire}</span>
        <span class="streak-num">${streak}</span>
        <span class="streak-label">天連續完成</span>
        ${longest > 0 ? `<span class="streak-best">最高 ${longest} 天</span>` : ''}
      </div>
      <div class="streak-days">${dots}</div>
    </div>
  `;
}

function renderDailyTemplateList(templates) {
  const list = document.getElementById('daily-template-list');
  if (!list) return;
  if (!templates.length) {
    list.innerHTML = '<p class="empty-msg">還沒有每日必辦事項，新增一個吧！</p>';
    return;
  }
  list.innerHTML = templates.map(t => `
    <div class="daily-template-item">
      <span class="daily-tmpl-icon">☑</span>
      <span class="daily-tmpl-title">${esc(t.title)}</span>
      <button class="daily-tmpl-del" onclick="__delDailyTmpl('${esc(t.id)}')" title="刪除">✕</button>
    </div>
  `).join('');
}

function renderDailyPinnedItems() {
  const container = document.getElementById('daily-pinned');
  if (!container) return;
  const record = todayRecordData;
  if (!record || !record.items || !record.items.length) {
    container.innerHTML = '';
    return;
  }

  const total     = record.items.length;
  const doneCount = record.items.filter(i => i.done).length;
  const allDone   = record.allDone;
  const today     = getTodayUTC8();

  const itemsHtml = record.items.map((item, i) => `
    <div class="daily-item-card${item.done ? ' done' : ''}">
      <div class="daily-item-left">
        <span class="daily-item-badge">每日必辦</span>
        <span class="daily-item-title">${esc(item.title)}</span>
      </div>
      <div class="daily-item-right">
        <span class="daily-item-time">📅 ${esc(today)}</span>
        <button class="daily-check-btn" onclick="__toggleDaily(${i})">
          ${item.done ? '撤銷' : '完成 ✓'}
        </button>
      </div>
    </div>
  `).join('');

  container.innerHTML = `
    <div class="daily-pinned-section">
      <div class="daily-pinned-header">
        <span>今日必辦</span>
        <span class="daily-progress-text">${doneCount}/${total} 完成${allDone ? ' 🎉' : ''}</span>
      </div>
      ${itemsHtml}
    </div>
  `;
}

window.__toggleDaily = async (itemIndex) => {
  const user = auth.currentUser;
  if (!user || !todayRecordData) return;
  const today = getTodayUTC8();
  const ref   = doc(db, 'users', user.uid, 'dailyRecords', today);
  const items = todayRecordData.items.map((item, i) =>
    i === itemIndex ? { ...item, done: !item.done } : item
  );
  const allDone = items.every(i => i.done);
  await updateDoc(ref, { items, allDone });
};

window.__delDailyTmpl = async (id) => {
  const user = auth.currentUser;
  if (!user) return;
  if (!confirm('確定要刪除這個每日必辦事項嗎？')) return;
  await deleteDoc(doc(db, 'users', user.uid, 'dailyTemplates', id));
};

// ── Pull-to-refresh ────────────────────────────────────────────────────────
function initPullToRefresh() {
  const THRESHOLD = 70;

  const el = document.createElement('div');
  el.id = 'ptr-indicator';
  el.innerHTML = '<div class="ptr-spinner"></div><span>下拉以重新整理</span>';
  document.body.appendChild(el);

  const label   = el.querySelector('span');
  const spinner = el.querySelector('.ptr-spinner');

  let startY = 0, startScrollTop = 0, delta = 0, active = false;

  function getActiveScrollTop() {
    for (const id of ['task-scroll-area', 'daily-view', 'notes-list', 'expense-list']) {
      const node = document.getElementById(id);
      if (node && node.offsetParent !== null) return node.scrollTop;
    }
    return 0;
  }

  document.addEventListener('touchstart', e => {
    startY         = e.touches[0].pageY;
    startScrollTop = getActiveScrollTop();
    delta  = 0;
    active = false;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    const dy = e.touches[0].pageY - startY;
    if (dy <= 0 || startScrollTop > 0) return;

    active = true;
    delta  = dy;

    const pullY    = Math.min(dy * 0.45, 52);
    const progress = Math.min(dy / THRESHOLD, 1);

    el.style.transform = `translateX(-50%) translateY(${pullY}px)`;
    el.style.opacity   = String(Math.min(progress * 1.4, 1));
    spinner.style.transform = `rotate(${progress * 360}deg)`;
    label.textContent = progress >= 1 ? '放開以重新整理' : '下拉以重新整理';

    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!active) return;
    active = false;

    if (delta >= THRESHOLD) {
      el.classList.add('ptr-loading');
      el.style.transform = 'translateX(-50%) translateY(56px)';
      el.style.opacity   = '1';
      label.textContent  = '重新整理中…';
      setTimeout(() => window.location.reload(), 500);
    } else {
      el.style.transition = 'transform 0.28s ease, opacity 0.28s ease';
      el.style.transform  = 'translateX(-50%) translateY(-64px)';
      el.style.opacity    = '0';
      const done = () => { el.style.transition = ''; el.removeEventListener('transitionend', done); };
      el.addEventListener('transitionend', done);
    }
    delta = 0;
  });
}

// ── Service worker ─────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
