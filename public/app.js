const log = document.getElementById('log');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const send = document.getElementById('send');
const attach = document.getElementById('attach');
const files = document.getElementById('files');
const draftsEl = document.getElementById('drafts');
const newChat = document.getElementById('new-chat');
const clearChat = document.getElementById('clear-chat');
const pauseButton = document.getElementById('pause');
const operatorForm = document.getElementById('operator');
const operatorText = document.getElementById('operator-text');
const operatorSend = document.getElementById('operator-send');
const adminStatus = document.getElementById('admin-status');
const signOut = document.getElementById('sign-out');
const gate = document.getElementById('gate');
const login = document.getElementById('login');
const tokenInput = document.getElementById('token');
const loginError = document.getElementById('login-error');
const roleButtons = [...document.querySelectorAll('.role')];
const shell = document.querySelector('.shell');

const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const mediaCache = new Map();
const state = {
  token: sessionStorage.getItem('adminApiKey') || null,
  authRequired: true,
  sessionId: sessionStorage.getItem('sessionId') || null,
  conversationId: sessionStorage.getItem('conversationId') || null,
  sender: sessionStorage.getItem('sender') || 'homeowner',
  busy: false,
  paused: false,
  drafts: [],
};

function persist() {
  for (const key of ['sessionId', 'conversationId', 'sender']) {
    if (state[key]) sessionStorage.setItem(key, state[key]);
    else sessionStorage.removeItem(key);
  }
}

function setSender(sender) {
  state.sender = sender;
  persist();
  input.placeholder = `Message as ${sender}…`;
  for (const button of roleButtons) button.setAttribute('aria-checked', String(button.dataset.sender === sender));
}

function setPaused(paused) {
  state.paused = !!paused;
  pauseButton.textContent = state.paused ? 'Resume' : 'Pause';
}

function setBusy(busy) {
  state.busy = busy;
  send.disabled = busy;
  attach.disabled = busy;
  input.disabled = false; // Keep the next message editable while this turn runs.
  operatorSend.disabled = busy;
}

function emptyHint(text) {
  log.replaceChildren();
  const hint = document.createElement('p');
  hint.className = 'empty';
  hint.id = 'empty';
  hint.textContent = text;
  log.append(hint);
}

function briefLine(brief) {
  if (!brief) return 'Brief is empty.';
  const parts = [
    brief.homeownerName && `Homeowner ${brief.homeownerName}`,
    brief.contractorName && `contractor ${brief.contractorName}`,
    brief.propertyAddress,
    brief.scope,
  ].filter(Boolean);
  return parts.length ? `Brief: ${parts.join(' · ')}` : 'Brief is empty.';
}

function renderAdmin(context = {}) {
  const handoffs = (context.handoffs ?? []).filter((task) => task.status === 'open');
  const failed = context.failedTurns ?? [];
  adminStatus.replaceChildren();
  const brief = document.createElement('p');
  brief.textContent = state.conversationId
    ? `${state.paused ? 'Paused. ' : ''}${briefLine(context.conversation?.brief)}`
    : 'No active conversation.';
  adminStatus.append(brief);
  for (const task of handoffs) {
    const line = document.createElement('p');
    line.textContent = `Handoff ${task.kind}: ${task.summary}`;
    const done = document.createElement('button');
    done.type = 'button';
    done.textContent = 'Complete';
    done.addEventListener('click', () => completeHandoff(task.id));
    line.append(done);
    adminStatus.append(line);
  }
  for (const turn of failed) {
    const line = document.createElement('p');
    line.textContent = `Failed turn: ${turn.last_error ?? 'unknown error'}`;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => retryTurn(turn.id, retry));
    line.append(retry);
    adminStatus.append(line);
  }
}

function hideEmpty() {
  document.getElementById('empty')?.remove();
}

async function authorizedSrc(url) {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return url;
  const path = url.startsWith('/local/media/') ? url.replace('/local/media/', '/api/media/') : url;
  if (mediaCache.has(path)) return mediaCache.get(path);
  const response = await fetch(path, { headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} });
  if (!response.ok) return path;
  const objectUrl = URL.createObjectURL(await response.blob());
  mediaCache.set(path, objectUrl);
  return objectUrl;
}

function addGallery(row, attachments) {
  if (!attachments?.length) return;
  const gallery = document.createElement('div');
  gallery.className = 'gallery';
  for (const file of attachments) {
    const img = document.createElement('img');
    img.alt = file.filename || 'Photo';
    if (file.preview) img.src = file.preview;
    else if (file.url) void authorizedSrc(file.url).then((src) => { img.src = src; });
    gallery.append(img);
  }
  row.append(gallery);
}

function append(kind, sender, text, extraClass = '', attachments = []) {
  hideEmpty();
  const row = document.createElement('article');
  row.className = `row ${kind}${extraClass ? ` ${extraClass}` : ''}`;
  if (sender) row.dataset.sender = sender;
  const who = document.createElement('p');
  who.className = 'who';
  who.textContent = sender || (kind === 'assistant' ? 'FORM' : 'Note');
  row.append(who);
  if (text) {
    const bubble = document.createElement('p');
    bubble.className = 'bubble';
    bubble.textContent = text;
    row.append(bubble);
  }
  addGallery(row, attachments);
  log.append(row);
  row.scrollIntoView({ block: 'end' });
  return row;
}

function showPending() {
  hideEmpty();
  const row = document.createElement('article');
  row.className = 'row assistant';
  row.id = 'pending';
  row.innerHTML = '<p class="who">FORM</p><p class="bubble pending" aria-label="FORM is designing"><i></i><i></i><i></i></p>';
  log.append(row);
  row.scrollIntoView({ block: 'end' });
}

function clearPending() {
  document.getElementById('pending')?.remove();
}

function clearDrafts() {
  for (const draft of state.drafts) URL.revokeObjectURL(draft.preview);
  state.drafts = [];
  renderDrafts();
}

function renderDrafts() {
  draftsEl.replaceChildren();
  draftsEl.hidden = state.drafts.length === 0;
  state.drafts.forEach((draft, index) => {
    const item = document.createElement('div');
    item.className = 'draft';
    const img = document.createElement('img');
    img.src = draft.preview;
    img.alt = draft.filename;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${draft.filename}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      URL.revokeObjectURL(draft.preview);
      state.drafts.splice(index, 1);
      renderDrafts();
    });
    item.append(img, remove);
    draftsEl.append(item);
  });
}

function blobToDraft(filename, mimeType, blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that photo'));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const data = dataUrl.split(',')[1];
      if (!data) { reject(new Error('Could not read that photo')); return; }
      resolve({ filename, mimeType, data, preview: URL.createObjectURL(blob) });
    };
    reader.readAsDataURL(blob);
  });
}

async function preparePhoto(file) {
  if (!allowedTypes.has(file.type)) throw new Error('Use a JPEG, PNG, WebP, or GIF');
  if (file.size > 20 * 1024 * 1024) throw new Error('Each photo must be 20 MB or smaller');
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not read that photo')), 'image/jpeg', 0.84);
    });
    return blobToDraft((file.name || 'photo').replace(/\.[^.]+$/, '.jpg'), 'image/jpeg', blob);
  } catch {
    if (!allowedTypes.has(file.type)) throw new Error('Could not read that photo. Try a JPEG or PNG.');
    return blobToDraft(file.name || 'photo', file.type, file);
  }
}

async function addFiles(fileList) {
  const incoming = [...fileList].filter(Boolean);
  if (!incoming.length) return;
  const remaining = 5 - state.drafts.length;
  if (remaining <= 0) {
    append('note', 'Error', 'You can send up to 5 photos at a time.', 'error');
    return;
  }
  try {
    for (const file of incoming.slice(0, remaining)) {
      state.drafts.push(await preparePhoto(file));
    }
    renderDrafts();
    if (incoming.length > remaining) {
      append('note', 'Error', 'You can send up to 5 photos at a time.', 'error');
    }
  } catch (error) {
    append('note', 'Error', error.message, 'error');
  }
}

function filesFromClipboard(event) {
  return [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.kind === 'file' && allowedTypes.has(item.type))
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers ?? {}),
    },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

async function waitForTurn(turnId) {
  let lastMessageId = null;
  const conversationId = state.conversationId;
  for (let attempt = 0; attempt < 180; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { turn } = await request(`/turns/${turnId}`);
    if (conversationId && conversationId === state.conversationId) {
      const context = await request(`/conversations/${conversationId}`);
      const newest = context.messages.at(-1)?.id;
      if (newest !== lastMessageId) {
        lastMessageId = newest;
        renderHistory(context);
        if (turn.status === 'pending' || turn.status === 'processing') showPending();
      }
    }
    if (turn.status === 'done') return turn;
    if (turn.status === 'failed' || turn.status === 'cancelled') {
      const error = new Error(turn.status === 'failed' ? 'That request didn’t finish. Retry it below, or send a new message.' : 'That request was stopped.');
      error.turnId = turn.id;
      error.failed = turn.status === 'failed';
      throw error;
    }
  }
  throw new Error('This is taking longer than expected. Your request is saved; check back here for the result.');
}

async function refreshAdmin() {
  if (!state.conversationId) {
    setPaused(false);
    renderAdmin();
    return;
  }
  const context = await request(`/conversations/${state.conversationId}`);
  setPaused(context.conversation?.paused);
  renderAdmin(context);
}

async function showTurn() {
  await refreshConversation();
}

async function retryTurn(turnId, button) {
  button.disabled = true;
  setBusy(true);
  showPending();
  try {
    await request(`/turns/${turnId}/retry`, { method: 'POST', body: '{}' });
    await waitForTurn(turnId);
    await showTurn();
  } catch (error) {
    append('note', 'Error', error.message, 'error');
  } finally {
    clearPending();
    setBusy(false);
    input.focus();
  }
}

function renderHistory(context) {
  setPaused(context.conversation?.paused);
  renderAdmin(context);
  log.replaceChildren();
  if (!context.messages.length) {
    emptyHint('Share the property address and photos of the current kitchen. Floor plans and inspiration photos help. FORM will generate a redesigned kitchen from what you send.');
    return;
  }
  for (const message of context.messages) {
    if (message.role === 'assistant' || message.role === 'operator') {
      append(message.role === 'operator' ? 'note' : 'assistant', message.role === 'operator' ? 'Operator' : 'FORM', message.text, '', message.attachments ?? []);
    } else {
      append('user', message.sender, message.text, '', message.attachments ?? []);
    }
  }
  for (const task of context.handoffs ?? []) {
    if (task.status === 'open') append('note', 'Handoff', `${task.kind}: ${task.summary}`);
  }
  if (context.conversation?.paused) {
    append('note', 'Paused', 'Conversation paused. Resume from Admin, or start a new chat.');
  }
}

async function refreshConversation() {
  if (!state.conversationId) {
    setPaused(false);
    renderAdmin();
    return;
  }
  renderHistory(await request(`/conversations/${state.conversationId}`));
}

async function restore() {
  setSender(state.sender);
  renderAdmin();
  if (!state.conversationId) return;
  try {
    await refreshConversation();
  } catch {
    state.sessionId = null;
    state.conversationId = null;
    persist();
    renderAdmin();
  }
}

function resetChat() {
  state.sessionId = null;
  state.conversationId = null;
  persist();
  setPaused(false);
  clearDrafts();
  emptyHint('New project. Share the property address and photos of the current kitchen, plus a floor plan or inspiration if you have them.');
  renderAdmin();
  input.focus();
}

async function clearCurrentChat() {
  if (!state.conversationId) { resetChat(); return; }
  if (!window.confirm('Clear this chat’s messages, brief, and queued work?')) return;
  await request(`/conversations/${state.conversationId}`, { method: 'DELETE' });
  resetChat();
}

async function togglePause() {
  if (!state.conversationId) return;
  const { conversation } = await request(`/conversations/${state.conversationId}`, {
    method: 'PATCH',
    body: JSON.stringify({ paused: !state.paused }),
  });
  setPaused(conversation.paused);
  await refreshConversation();
}

async function completeHandoff(id) {
  await request(`/handoffs/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) });
  await refreshConversation();
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
}

for (const button of roleButtons) {
  button.addEventListener('click', () => setSender(button.dataset.sender));
}

newChat.addEventListener('click', resetChat);
clearChat.addEventListener('click', () => { void clearCurrentChat().catch((error) => append('note', 'Error', error.message, 'error')); });
pauseButton.addEventListener('click', () => { void togglePause().catch((error) => append('note', 'Error', error.message, 'error')); });
operatorForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = operatorText.value.trim();
  if (!text || !state.conversationId || state.busy) return;
  operatorText.value = '';
  setBusy(true);
  showPending();
  try {
    const queued = await request(`/conversations/${state.conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, requestId: crypto.randomUUID() }),
    });
    await waitForTurn(queued.turnId);
    await refreshConversation();
  } catch (error) {
    append('note', 'Error', error.message, 'error');
  } finally {
    clearPending();
    setBusy(false);
    input.focus();
  }
});
attach.addEventListener('click', () => files.click());
files.addEventListener('change', () => {
  void addFiles(files.files ?? []);
  files.value = '';
});

input.addEventListener('input', resizeInput);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

document.addEventListener('paste', (event) => {
  if (state.busy) return;
  const photos = filesFromClipboard(event);
  if (!photos.length) return;
  event.preventDefault();
  const text = event.clipboardData?.getData('text');
  if (text && document.activeElement === input) {
    input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
    resizeInput();
  }
  void addFiles(photos);
});

let dragDepth = 0;
document.addEventListener('dragenter', (event) => {
  if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return;
  event.preventDefault();
  dragDepth += 1;
  shell.classList.add('drop');
});
document.addEventListener('dragover', (event) => {
  if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return;
  event.preventDefault();
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) shell.classList.remove('drop');
});
document.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  dragDepth = 0;
  shell.classList.remove('drop');
  if (!state.busy) void addFiles(event.dataTransfer.files);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  const attachments = state.drafts.map(({ filename, mimeType, data }) => ({ filename, mimeType, data }));
  const previews = state.drafts.map(({ filename, preview }) => ({ filename, preview }));
  if ((!message && !attachments.length) || state.busy) return;
  input.value = '';
  resizeInput();
  state.drafts = [];
  renderDrafts();
  append('user', state.sender, message, '', previews);
  setBusy(true);
  showPending();
  try {
    const queued = await request('/sandbox/messages', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: state.sessionId ?? undefined,
        sender: state.sender,
        message,
        attachments,
      }),
    });
    state.sessionId = queued.sessionId;
    state.conversationId = queued.conversationId;
    persist();
    if (queued.paused) {
      setPaused(true);
      append('note', 'Paused', 'Conversation paused. Resume from Admin, or start a new chat.');
      void refreshAdmin().catch(() => {});
      return;
    }
    await waitForTurn(queued.turnId);
    await showTurn();
  } catch (error) {
    const row = append('note', 'Error', error.message, 'error');
    if (error.failed && error.turnId) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'retry';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => retryTurn(error.turnId, retry));
      row.append(retry);
    }
  } finally {
    clearPending();
    setBusy(false);
    input.focus();
  }
});

function showGate(message) {
  shell.hidden = true;
  gate.hidden = false;
  signOut.hidden = true;
  if (message) {
    loginError.hidden = false;
    loginError.textContent = message;
  } else {
    loginError.hidden = true;
  }
  tokenInput.focus();
}

function openApp() {
  gate.hidden = true;
  shell.hidden = false;
  signOut.hidden = !state.authRequired;
  void restore();
  input.focus();
}

function persistToken(token) {
  state.token = token;
  if (token) sessionStorage.setItem('adminApiKey', token);
  else sessionStorage.removeItem('adminApiKey');
}

login.addEventListener('submit', async (event) => {
  event.preventDefault();
  persistToken(tokenInput.value.trim());
  try {
    await request('/conversations');
    openApp();
  } catch {
    persistToken(null);
    showGate('That admin key was not accepted.');
  }
});

signOut.addEventListener('click', () => {
  persistToken(null);
  tokenInput.value = '';
  showGate();
});

void (async () => {
  try {
    const config = await (await fetch('/config')).json();
    state.authRequired = !!config.authRequired;
    if (config.token) persistToken(config.token);
  } catch {
    state.authRequired = true;
  }
  if (!state.token) {
    showGate();
    return;
  }
  try {
    await request('/conversations');
    openApp();
  } catch {
    persistToken(null);
    showGate(state.authRequired ? 'Enter the service ADMIN_API_KEY to continue.' : 'Could not reach the admin API.');
  }
})();
