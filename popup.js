/**
 * HXLoLi-NaGaMe - Popup Script v3
 *
 * GitHub Device Flow OAuth 授权界面
 * 用户完全不需要接触 RSA 密钥
 */

/* global chrome */

const $ = (id) => document.getElementById(id);

// ============ DOM 元素 ============

const statusDot = $('statusDot');
const statusText = $('statusText');
const userCard = $('userCard');
const userAvatar = $('userAvatar');
const userName = $('userName');
const userKeyStatus = $('userKeyStatus');
const logoutBtn = $('logoutBtn');
const authSection = $('authSection');
const authBtn = $('authBtn');
const deviceFlowPanel = $('deviceFlowPanel');
const userCodeEl = $('userCode');
const verificationLink = $('verificationLink');
const pollStatus = $('pollStatus');
const autoDecryptSwitch = $('autoDecryptSwitch');
const enableSwitch = $('enableSwitch');
const refreshKeyBtn = $('refreshKeyBtn');
const refreshPageBtn = $('refreshPageBtn');
const tokenToggle = $('tokenToggle');
const tokenArrow = $('tokenArrow');
const tokenBody = $('tokenBody');
const tokenInput = $('tokenInput');
const tokenSubmit = $('tokenSubmit');
const toast = $('toast');

// ============ 工具 ============

function showToast(msg, color = '#3fb950') {
  toast.textContent = msg;
  toast.style.background = color;
  toast.style.color = color === '#f85149' ? '#fff' : '#0d1117';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function sendMsg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response);
    });
  });
}

// ============ 状态显示 ============

function updateUI(config) {
  const loggedIn = config.hasToken;

  // 状态栏
  if (!config.enabled) {
    statusDot.className = 'status-dot inactive';
    statusText.textContent = '插件已禁用';
  } else if (!loggedIn) {
    statusDot.className = 'status-dot warning';
    statusText.textContent = '请授权 GitHub 以解锁页面';
  } else if (!config.hasKey) {
    statusDot.className = 'status-dot warning';
    statusText.textContent = '已授权, 但私钥未加载';
  } else {
    statusDot.className = 'status-dot active';
    statusText.textContent = config.autoDecrypt ? '🔓 自动解密已启用' : '手动模式';
  }

  // 用户卡片 vs 授权按钮
  if (loggedIn) {
    userCard.classList.remove('hidden');
    authSection.classList.add('hidden');

    userName.textContent = config.githubUser || '已授权';
    userAvatar.textContent = '🐙';

    if (config.hasKey) {
      userKeyStatus.textContent = '✅ RSA 私钥已加载';
      userKeyStatus.className = 'user-status';
    } else {
      userKeyStatus.textContent = '⚠️ 私钥未加载, 请检查 HXLoLi-imouto 仓库';
      userKeyStatus.className = 'user-status warning';
    }
  } else {
    userCard.classList.add('hidden');
    authSection.classList.remove('hidden');
  }

  // 开关
  autoDecryptSwitch.checked = config.autoDecrypt !== false;
  enableSwitch.checked = config.enabled !== false;
}

// ============ 初始化 ============

async function init() {
  const config = await sendMsg({ type: 'GET_FULL_CONFIG' });
  if (config) {
    updateUI(config);
  }

  // 检查是否有正在进行的授权 (用户可能关了 popup 再打开)
  const stored = await chrome.storage.local.get('authState');
  if (stored.authState) {
    handleAuthState(stored.authState);
  }
}

// ============ GitHub Device Flow 授权 ============

authBtn.addEventListener('click', async () => {
  authBtn.disabled = true;
  authBtn.textContent = '正在连接 GitHub...';

  try {
    // 只发一条消息给 background, 它会:
    // 1. 启动 Device Flow
    // 2. 打开 GitHub 验证页面
    // 3. 在后台持续轮询 token (popup 关了也没关系!)
    // 4. 结果写入 storage.local.authState
    const result = await sendMsg({ type: 'START_GITHUB_AUTH' });

    if (!result?.success) {
      throw new Error(result?.error || '启动授权失败');
    }

    // 显示验证码面板
    deviceFlowPanel.classList.add('show');
    authSection.classList.add('hidden');

    userCodeEl.textContent = result.user_code;
    verificationLink.href = result.verification_uri;
    pollStatus.textContent = '⏳ 等待授权中... (可以关闭此弹窗, 后台会继续等待)';

  } catch (err) {
    showToast(`❌ ${err.message}`, '#f85149');
    authBtn.disabled = false;
    authBtn.innerHTML = `
      <svg class="gh-icon" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
      </svg>
      通过 GitHub 授权
    `;
  }
});

// ============ 监听后台授权结果 (核心: popup 关了重开也能感知) ============

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.authState) return;
  const authState = changes.authState.newValue;
  if (!authState) return;

  handleAuthState(authState);
});

async function handleAuthState(authState) {
  if (authState.status === 'pending') {
    // 正在等待用户授权
    deviceFlowPanel.classList.add('show');
    authSection.classList.add('hidden');
    userCodeEl.textContent = authState.userCode;
    verificationLink.href = authState.verificationUri;
    pollStatus.textContent = '⏳ 等待授权中... (可以关闭此弹窗, 后台会继续等待)';
  }

  if (authState.status === 'success') {
    deviceFlowPanel.classList.remove('show');

    if (authState.keyLoaded) {
      showToast(`✅ 欢迎, ${authState.username}! 私钥已加载`);
    } else {
      showToast(`⚠️ 授权成功, 但私钥加载失败: ${authState.keyError}`, '#d29922');
    }

    // 刷新 UI
    const config = await sendMsg({ type: 'GET_FULL_CONFIG' });
    if (config) updateUI(config);

    // 清除 authState
    chrome.storage.local.remove('authState');

    // 通知当前标签页重试
    notifyTab();
  }

  if (authState.status === 'error') {
    deviceFlowPanel.classList.remove('show');
    authSection.classList.remove('hidden');
    showToast(`❌ ${authState.error}`, '#f85149');

    authBtn.disabled = false;
    authBtn.innerHTML = `
      <svg class="gh-icon" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
      </svg>
      通过 GitHub 授权
    `;

    // 清除 authState
    chrome.storage.local.remove('authState');
  }
}

// ============ 复制验证码 ============

userCodeEl.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(userCodeEl.textContent);
    userCodeEl.classList.add('copied');
    showToast('📋 验证码已复制!');
    setTimeout(() => userCodeEl.classList.remove('copied'), 2000);
  } catch {
    // fallback
    const textArea = document.createElement('textarea');
    textArea.value = userCodeEl.textContent;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
    showToast('📋 验证码已复制!');
  }
});

// ============ 登出 ============

logoutBtn.addEventListener('click', async () => {
  if (!confirm('确定登出? 将清除本地缓存的 Token 和私钥。')) return;

  const result = await sendMsg({ type: 'LOGOUT' });
  if (result?.success) {
    showToast('👋 已登出');
    const config = await sendMsg({ type: 'GET_FULL_CONFIG' });
    if (config) updateUI(config);
  }
});

// ============ 开关 ============

autoDecryptSwitch.addEventListener('change', async () => {
  await sendMsg({
    type: 'UPDATE_SETTINGS',
    autoDecrypt: autoDecryptSwitch.checked,
  });
  showToast(autoDecryptSwitch.checked ? '🔓 自动解密已开启' : '🔒 自动解密已关闭');
});

enableSwitch.addEventListener('change', async () => {
  await sendMsg({
    type: 'UPDATE_SETTINGS',
    enabled: enableSwitch.checked,
  });
  showToast(enableSwitch.checked ? '✅ 插件已启用' : '⏸️ 插件已禁用');
});

// ============ 刷新私钥 ============

refreshKeyBtn.addEventListener('click', async () => {
  refreshKeyBtn.disabled = true;
  refreshKeyBtn.textContent = '🔑 刷新中...';

  const result = await sendMsg({ type: 'REFRESH_KEY' });

  if (result?.success) {
    showToast('✅ RSA 私钥已刷新');
    const config = await sendMsg({ type: 'GET_FULL_CONFIG' });
    if (config) updateUI(config);
    notifyTab();
  } else {
    showToast(`❌ ${result?.error || '刷新失败'}`, '#f85149');
  }

  refreshKeyBtn.disabled = false;
  refreshKeyBtn.textContent = '🔑 刷新私钥';
});

// ============ 刷新页面 ============

refreshPageBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.reload(tab.id);
      showToast('🔄 页面已刷新');
    }
  } catch {
    showToast('❌ 刷新失败', '#f85149');
  }
});

// ============ 备用: Token 输入折叠面板 ============

tokenToggle.addEventListener('click', () => {
  const isOpen = tokenBody.classList.toggle('show');
  tokenArrow.classList.toggle('open', isOpen);
});

tokenSubmit.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    showToast('⚠️ 请输入 Token', '#d29922');
    return;
  }

  tokenSubmit.disabled = true;
  tokenSubmit.textContent = '验证中...';

  const result = await sendMsg({ type: 'SET_GITHUB_TOKEN', token });

  if (result?.success) {
    tokenInput.value = '';

    if (result.keyLoaded) {
      showToast(`✅ 欢迎, ${result.username}! 私钥已加载`);
    } else {
      showToast(`⚠️ Token 有效, 但私钥加载失败: ${result.keyError}`, '#d29922');
    }

    const config = await sendMsg({ type: 'GET_FULL_CONFIG' });
    if (config) updateUI(config);
    notifyTab();

    // 收起折叠面板
    tokenBody.classList.remove('show');
    tokenArrow.classList.remove('open');
  } else {
    showToast(`❌ ${result?.error || 'Token 无效'}`, '#f85149');
  }

  tokenSubmit.disabled = false;
  tokenSubmit.textContent = '验证并保存 Token';
});

// ============ 通知标签页重试解密 ============

async function notifyTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && (
      tab.url.includes('hengxin666.github.io/HXLoLi') ||
      tab.url.includes('hxloli.pages.dev') ||
      tab.url.includes('localhost')
    )) {
      chrome.tabs.sendMessage(tab.id, { type: 'RETRY_DECRYPT' }).catch(() => {});
    }
  } catch {
    // ignore
  }
}

// ============ 启动 ============

init();
