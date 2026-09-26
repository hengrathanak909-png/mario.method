const videoInput = document.querySelector('#video-file');
const videoPreview = document.querySelector('#video-preview');
const emptyPreview = document.querySelector('#empty-preview');
const dropZone = document.querySelector('#drop-zone');
const fileName = document.querySelector('#file-name');
const fileSize = document.querySelector('#file-size');
const removeFile = document.querySelector('#remove-file');
const chooseFile = document.querySelector('#choose-file');
const accountSelect = document.querySelector('#account-select');
const connectionLight = document.querySelector('#connection-light');
const connectionTitle = document.querySelector('#connection-title');
const connectionDetail = document.querySelector('#connection-detail');
const loginForm = document.querySelector('#login-form');
const accessPassword = document.querySelector('#access-password');
const loginButton = document.querySelector('#login-button');
const logoutButton = document.querySelector('#logout-button');
const verifyApiButton = document.querySelector('#verify-api-key');
const publishStatus = document.querySelector('#publish-status');
const publishButton = document.querySelector('#publish-button');
const publishLabel = document.querySelector('#publish-label');
const scheduleField = document.querySelector('#schedule-field');
const scheduledFor = document.querySelector('#scheduled-for');
const caption = document.querySelector('#caption');
const captionCount = document.querySelector('#caption-count');
const postForm = document.querySelector('#post-form');
let previewUrl = null;
let creatorOptionsReady = false;
let maxVideoDuration = null;

function setPublishingLocked(locked) {
  postForm.querySelectorAll('input, textarea, button, select').forEach((control) => {
    control.disabled = locked;
  });
  postForm.setAttribute('aria-disabled', String(locked));
}

function setConnection(connected, title, detail) {
  connectionLight.classList.toggle('is-ready', connected);
  connectionTitle.textContent = title;
  connectionDetail.textContent = detail;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || result.message || `Request failed (${response.status})`);
  return result;
}

async function loadAccounts() {
  try {
    const result = await apiRequest('/api/accounts');
    const accounts = result.accounts || [];
    accountSelect.replaceChildren(new Option('Choose a TikTok account', ''));
    accounts.forEach((account) => {
      const label = account.username ? `@${account.username}` : `TikTok account ${account.id.slice(0, 8)}`;
      accountSelect.add(new Option(label, account.id));
    });
    accountSelect.hidden = accounts.length === 0;
    document.querySelector('#refresh-accounts').hidden = accounts.length === 0;
    document.querySelector('#connect-account').textContent = accounts.length ? 'ADD TIKTOK ACCOUNT' : 'CONNECT WITH TIKTOK';
    if (accounts.length) {
      setConnection(true, 'TikTok account connected', `${accounts.length} account${accounts.length === 1 ? '' : 's'} available through PostPeer.`);
      accountSelect.value = accounts[0].id;
      await loadCreatorOptions();
    } else {
      setConnection(false, 'No TikTok account connected', 'Connect a TikTok account through PostPeer to publish.');
    }
  } catch (error) {
    setConnection(false, 'Could not load TikTok accounts', error.message);
  }
}

async function checkApi() {
  try {
    const result = await apiRequest('/api/status');
    if (!result.configured) {
      setConnection(false, 'PostPeer API key needed', 'Start server.py and enter your key in the terminal. It is never entered on this website.');
      document.querySelector('#connect-account').disabled = true;
      return;
    }
    if (!result.valid) {
      setConnection(false, 'PostPeer API key was rejected', result.message || 'Check the key in the server terminal and restart it.');
      document.querySelector('#connect-account').disabled = true;
      return;
    }
    document.querySelector('#connect-account').disabled = false;
    await loadAccounts();
  } catch {
    setConnection(false, 'Local publisher is not running', 'Run python server.py, enter your PostPeer key in the terminal, then open http://127.0.0.1:4173.');
    document.querySelector('#connect-account').disabled = true;
  }
}

document.querySelector('#verify-api-key').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  setConnection(false, 'Checking PostPeer API key', 'The local server is validating it with PostPeer...');
  await checkSession();
  button.disabled = false;
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  try {
    await apiRequest('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: accessPassword.value })
    });
    accessPassword.value = '';
    loginForm.hidden = true;
    logoutButton.hidden = false;
    verifyApiButton.hidden = false;
    document.body.classList.remove('is-signed-out');
    await checkApi();
  } catch (error) {
    setConnection(false, 'Sign-in failed', error.message);
  } finally {
    loginButton.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  try {
    await apiRequest('/api/logout', { method: 'POST', body: '{}' });
  } finally {
    await checkSession();
  }
});

document.querySelector('#connect-account').addEventListener('click', async () => {
  const button = document.querySelector('#connect-account');
  button.disabled = true;
  try {
    const result = await apiRequest('/api/connect');
    if (!result.url) throw new Error('PostPeer did not return an authorization URL.');
    window.location.assign(result.url);
  } catch (error) {
    setConnection(false, 'Could not start TikTok connection', error.message);
    button.disabled = false;
  }
});

document.querySelector('#refresh-accounts').addEventListener('click', loadAccounts);
accountSelect.addEventListener('change', loadCreatorOptions);

async function loadCreatorOptions() {
  const accountId = accountSelect.value;
  creatorOptionsReady = false;
  if (!accountId) return;
  try {
    const result = await apiRequest(`/api/creator-info?accountId=${encodeURIComponent(accountId)}`);
    const info = result.creatorInfo || result.data || result;
    const availableOptions = info.privacyLevelOptions;
    if (!Array.isArray(availableOptions)) throw new Error('TikTok did not return this account\'s privacy choices.');
    const privacyValues = availableOptions.map((option) => typeof option === 'string' ? option : option.value || option.privacyLevel || option.id);
    const privacyInputs = [...document.querySelectorAll('input[name="audience"]')];
    privacyInputs.forEach((input) => { input.disabled = !privacyValues.includes(input.value); });
    const selected = privacyInputs.find((input) => input.checked && !input.disabled);
    if (!selected) {
      const firstAvailable = privacyInputs.find((input) => !input.disabled);
      if (firstAvailable) firstAvailable.checked = true;
    }
    maxVideoDuration = Number(info.maxVideoPostDurationSec) || null;
    creatorOptionsReady = privacyInputs.some((input) => !input.disabled);
    if (!creatorOptionsReady) throw new Error('This TikTok account has no available privacy options for video posts.');
  } catch (error) {
    setPublishStatus(error.message, true);
  }
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showFile(file) {
  if (!file || !file.type.startsWith('video/')) {
    fileName.textContent = 'Choose a video file';
    fileSize.textContent = 'VIDEO ONLY';
    return;
  }
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  videoPreview.src = previewUrl;
  videoPreview.hidden = false;
  emptyPreview.hidden = true;
  fileName.textContent = file.name;
  fileSize.textContent = formatSize(file.size);
  removeFile.hidden = false;
}

function clearFile() {
  videoInput.value = '';
  videoPreview.pause();
  videoPreview.removeAttribute('src');
  videoPreview.load();
  videoPreview.hidden = true;
  emptyPreview.hidden = false;
  fileName.textContent = 'No video selected';
  fileSize.textContent = 'MP4 · MOV';
  removeFile.hidden = true;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

videoInput.addEventListener('change', () => showFile(videoInput.files[0]));
removeFile.addEventListener('click', clearFile);
chooseFile.addEventListener('click', () => videoInput.click());
videoPreview.addEventListener('loadedmetadata', () => {
  if (maxVideoDuration && videoPreview.duration > maxVideoDuration) {
    setPublishStatus(`This account's current video limit is ${Math.floor(maxVideoDuration / 60)}:${String(Math.floor(maxVideoDuration % 60)).padStart(2, '0')}.`, true);
  }
});

dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    videoInput.click();
  }
});
['dragenter', 'dragover'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  dropZone.classList.add('is-dragging');
}));
['dragleave', 'drop'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  dropZone.classList.remove('is-dragging');
}));
dropZone.addEventListener('drop', (event) => showFile(event.dataTransfer.files[0]));

caption.addEventListener('input', () => {
  captionCount.textContent = `${caption.value.length} character${caption.value.length === 1 ? '' : 's'}`;
});

document.querySelectorAll('input[name="delivery"]').forEach((input) => input.addEventListener('change', () => {
  const schedule = input.value === 'schedule' && input.checked;
  scheduleField.hidden = !schedule;
  publishLabel.textContent = schedule ? 'SCHEDULE TIKTOK POST' : 'AUTO-POST TO TIKTOK';
}));

postForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = videoInput.files[0];
  const accountId = accountSelect.value;
  const delivery = document.querySelector('input[name="delivery"]:checked').value;
  if (!file) return setPublishStatus('Choose a video before publishing.', true);
  if (!accountId) return setPublishStatus('Connect and select a TikTok account first.', true);
  if (!creatorOptionsReady) return setPublishStatus('Refresh the account and privacy options before publishing.', true);
  if (!document.querySelector('#confirm-post').checked) return setPublishStatus('Confirm your final review before posting.', true);
  if (delivery === 'schedule' && !scheduledFor.value) return setPublishStatus('Choose a date and time for the scheduled post.', true);
  if (delivery === 'schedule' && new Date(scheduledFor.value).getTime() <= Date.now()) return setPublishStatus('Choose a future date and time.', true);
  if (maxVideoDuration && videoPreview.duration && videoPreview.duration > maxVideoDuration) return setPublishStatus('This video is longer than the connected TikTok account allows.', true);

  publishButton.disabled = true;
  setPublishStatus('Requesting a secure PostPeer upload URL...');
  try {
    const upload = await apiRequest('/api/media/upload', {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, mimeType: file.type })
    });
    const media = upload.data || upload;
    if (!media.uploadUrl || !media.publicUrl) throw new Error('PostPeer did not return both upload and media URLs.');

    setPublishStatus('Uploading your video to PostPeer...');
    const uploaded = await fetch(media.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!uploaded.ok) throw new Error(`Video upload failed (${uploaded.status}).`);

    const audience = document.querySelector('input[name="audience"]:checked').value;
    const payload = {
      content: caption.value.trim(),
      accountId,
      mediaUrl: media.publicUrl,
      privacyLevel: audience,
      disableComment: !document.querySelector('#allow-comments').checked,
      disableDuet: !document.querySelector('#allow-duet').checked,
      disableStitch: !document.querySelector('#allow-stitch').checked,
      idempotencyKey: crypto.randomUUID(),
      delivery
    };
    if (delivery === 'schedule') {
      payload.scheduledFor = scheduledFor.value;
      payload.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    }

    setPublishStatus(delivery === 'schedule' ? 'Scheduling your TikTok post...' : 'Sending your post to TikTok...');
    const result = await apiRequest('/api/posts', { method: 'POST', body: JSON.stringify(payload) });
    const postStatus = result.status || 'accepted';
    const postId = result.postId ? ` Post ID: ${result.postId}.` : '';
    setPublishStatus(postStatus === 'scheduled' ? `Your TikTok post is scheduled.${postId}` : `PostPeer accepted the request (${postStatus}).${postId}`);
  } catch (error) {
    setPublishStatus(error.message, true);
  } finally {
    publishButton.disabled = false;
  }
});

function setPublishStatus(message, isError = false) {
  publishStatus.textContent = message;
  publishStatus.classList.toggle('is-error', isError);
}

async function checkSession() {
  try {
    const session = await apiRequest('/api/session');
    if (!session.authenticated) {
      setPublishingLocked(true);
      document.body.classList.add('is-signed-out');
      loginForm.hidden = false;
      logoutButton.hidden = true;
      verifyApiButton.hidden = true;
      accountSelect.hidden = true;
      document.querySelector('#refresh-accounts').hidden = true;
      document.querySelector('#connect-account').hidden = true;
      document.querySelector('#connect-account').disabled = true;
      setConnection(false, 'Sign in to publish', 'The site is public to browse; TikTok connection and publishing are private.');
      return;
    }
    setPublishingLocked(false);
    document.body.classList.remove('is-signed-out');
    loginForm.hidden = true;
    logoutButton.hidden = !session.requiresLogin;
    verifyApiButton.hidden = false;
    document.querySelector('#connect-account').hidden = false;
    await checkApi();
  } catch {
    setPublishingLocked(true);
    loginForm.hidden = true;
    logoutButton.hidden = true;
    verifyApiButton.hidden = false;
    document.querySelector('#connect-account').hidden = false;
    setConnection(false, 'Local publisher is not running', 'Run python server.py, enter your PostPeer key in the terminal, then open http://127.0.0.1:4173.');
    document.querySelector('#connect-account').disabled = true;
  }
}

checkSession();
