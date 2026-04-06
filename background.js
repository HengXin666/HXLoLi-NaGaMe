/**
 * HXLoLi-NaGaMe - Background Service Worker v3
 *
 * 安全架构: RSA-OAEP (2048-bit) + AES-256-GCM 混合解密
 *
 * 核心流程:
 *   1. 用户通过 GitHub Device Flow OAuth 授权
 *   2. 插件用 GitHub Token 从私有仓库 HXLoLi-imouto 拉取 RSA 私钥
 *   3. 私钥缓存在 extension storage 中
 *   4. 收到密文 → RSA-OAEP 解密 AES 密钥 → AES-256-GCM 解密正文
 *
 * 用户完全不需要知道 RSA 密钥的存在!
 * 只需要授权 GitHub 就可以了。
 */

/* global chrome, EXT */

// ============ 配置 ============

/**
 * GitHub OAuth App Client ID
 *
 * 这是公开的, 不需要保密。
 * 你需要在 GitHub Settings > Developer settings > OAuth Apps 中创建一个 App
 * 并启用 Device Flow。
 *
 * TODO: 部署时替换为你的真实 Client ID
 */
const GITHUB_CLIENT_ID = 'Ov23lilHGEsqAmzZK1UV';

/** 私有仓库信息 */
const PRIVATE_REPO = {
  owner: 'HengXin666',
  repo: 'HXLoLi-imouto',
  /** 私钥文件在仓库中的路径 */
  keyPath: 'private-key.pem',
  /** 分支 */
  branch: 'main',
};

/** 默认配置 */
const DEFAULT_CONFIG = {
  enabled: true,
  autoDecrypt: true,
  /** GitHub Access Token (通过 Device Flow 获得) */
  githubToken: '',
  /** GitHub 用户名 (展示用) */
  githubUser: '',
  /** RSA 私钥 PEM (从 HXLoLi-imouto 拉取, 缓存) */
  rsaPrivateKeyPem: '',
  /** 私钥最后拉取时间 */
  keyFetchedAt: 0,
  targetSites: [
    'https://hengxin666.github.io/HXLoLi',
    'https://hxloli.pages.dev',
    'http://localhost',
  ],
};

// ============ 工具函数 ============

/** 获取或初始化配置 */
async function getConfig() {
  const stored = await chrome.storage.local.get('config');
  return stored.config || { ...DEFAULT_CONFIG };
}

/** 保存配置 */
async function setConfig(config) {
  await chrome.storage.local.set({ config });
}

// ============ 初始化 ============

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get('config');
  if (!stored.config) {
    await chrome.storage.local.set({ config: { ...DEFAULT_CONFIG } });
    console.log('🔐 HXLoLi-NaGaMe v3: 初始化配置完成');
  } else {
    // 迁移旧配置
    const config = stored.config;
    let needSave = false;

    // 确保新字段存在
    if (config.githubToken === undefined) {
      config.githubToken = '';
      needSave = true;
    }
    if (config.githubUser === undefined) {
      config.githubUser = '';
      needSave = true;
    }
    if (config.keyFetchedAt === undefined) {
      config.keyFetchedAt = 0;
      needSave = true;
    }

    // 清理旧版字段
    for (const oldField of ['password', 'decryptKey']) {
      if (config[oldField]) {
        delete config[oldField];
        needSave = true;
      }
    }

    if (needSave) {
      await chrome.storage.local.set({ config });
      console.log('🔄 HXLoLi-NaGaMe v3: 已迁移旧配置');
    }
  }
});

// ============ GitHub Device Flow OAuth ============

/**
 * 发起 GitHub Device Flow 授权
 *
 * 流程:
 *   1. POST github.com/login/device/code → 获取 user_code + verification_uri
 *   2. 用户在浏览器中打开 verification_uri，输入 user_code
 *   3. 插件轮询 github.com/login/oauth/access_token → 获取 access_token
 *
 * Device Flow 不需要 client_secret！
 *
 * @returns {{ user_code: string, verification_uri: string, device_code: string, interval: number, expires_in: number }}
 */
async function startDeviceFlow() {
  const resp = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: 'repo',  // 需要访问私有仓库
    }),
  });

  if (!resp.ok) {
    throw new Error(`GitHub Device Flow 启动失败: ${resp.status} ${resp.statusText}`);
  }

  return resp.json();
}

/**
 * 轮询 GitHub 获取 Access Token
 *
 * @param {string} deviceCode - 从 startDeviceFlow 获取的 device_code
 * @param {number} interval - 轮询间隔 (秒)
 * @param {number} expiresIn - 过期时间 (秒)
 * @returns {Promise<string>} access_token
 */
async function pollForToken(deviceCode, interval, expiresIn) {
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = interval * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval));

    const resp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = await resp.json();

    if (data.access_token) {
      return data.access_token;
    }

    if (data.error === 'authorization_pending') {
      // 用户还没授权, 继续等
      continue;
    }

    if (data.error === 'slow_down') {
      // 太快了, 增加间隔
      pollInterval += 5000;
      continue;
    }

    if (data.error === 'expired_token') {
      throw new Error('授权超时, 请重新操作');
    }

    if (data.error === 'access_denied') {
      throw new Error('用户拒绝了授权');
    }

    throw new Error(`GitHub OAuth 错误: ${data.error || '未知错误'}`);
  }

  throw new Error('授权超时');
}

// ============ GitHub API: 拉取私钥 ============

/**
 * 从 HXLoLi-imouto 私有仓库拉取 RSA 私钥
 *
 * @param {string} token - GitHub Access Token
 * @returns {Promise<string>} RSA 私钥 PEM 内容
 */
async function fetchPrivateKey(token) {
  const url = `https://api.github.com/repos/${PRIVATE_REPO.owner}/${PRIVATE_REPO.repo}/contents/${PRIVATE_REPO.keyPath}?ref=${PRIVATE_REPO.branch}`;

  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3.raw',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error('GitHub Token 无效或已过期, 请重新授权');
  }

  if (resp.status === 404) {
    throw new Error(
      `找不到私钥文件: ${PRIVATE_REPO.owner}/${PRIVATE_REPO.repo}/${PRIVATE_REPO.keyPath}\n` +
      `请确认仓库 HXLoLi-imouto 中有 private-key.pem 文件`
    );
  }

  if (!resp.ok) {
    throw new Error(`拉取私钥失败: ${resp.status} ${resp.statusText}`);
  }

  const pem = await resp.text();

  // 验证是有效的 PEM
  if (!pem.includes('-----BEGIN') || !pem.includes('PRIVATE KEY')) {
    throw new Error('拉取到的文件不是有效的 PEM 私钥');
  }

  return pem.trim();
}

/**
 * 验证 GitHub Token 有效性 + 获取用户名
 *
 * @param {string} token
 * @returns {Promise<string>} 用户名
 */
async function verifyToken(token) {
  const resp = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!resp.ok) {
    throw new Error('Token 无效');
  }

  const user = await resp.json();
  return user.login;
}

/**
 * 确保私钥已加载 (从缓存或远端拉取)
 *
 * @param {object} config - 当前配置
 * @returns {Promise<object>} 更新后的配置 (包含私钥)
 */
async function ensurePrivateKey(config) {
  // 如果已有缓存的私钥，且不超过 24 小时，直接用
  const KEY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
  if (config.rsaPrivateKeyPem && (Date.now() - config.keyFetchedAt) < KEY_CACHE_TTL) {
    return config;
  }

  if (!config.githubToken) {
    throw new Error('no_token');
  }

  // 拉取私钥
  console.log('[HXLoLi-NaGaMe] 🔑 从 HXLoLi-imouto 拉取 RSA 私钥...');
  const pem = await fetchPrivateKey(config.githubToken);

  config.rsaPrivateKeyPem = pem;
  config.keyFetchedAt = Date.now();
  await setConfig(config);

  console.log('[HXLoLi-NaGaMe] ✅ RSA 私钥已更新');
  return config;
}

// ============ PEM → CryptoKey 导入 ============

/**
 * 将 PEM 格式的 RSA 私钥导入为 Web Crypto API 的 CryptoKey
 *
 * @param {string} pem - PKCS#8 PEM 格式的 RSA 私钥
 * @returns {Promise<CryptoKey>}
 */
async function importRsaPrivateKey(pem) {
  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
    .replace(/-----END RSA PRIVATE KEY-----/, '')
    .replace(/\s/g, '');

  const binaryStr = atob(pemBody);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      bytes.buffer,
      {
        name: 'RSA-OAEP',
        hash: 'SHA-256',
      },
      false,
      ['decrypt']
    );
  } catch (e) {
    throw new Error(
      '私钥格式错误。请确保 HXLoLi-imouto 中的 private-key.pem 是 PKCS#8 格式。\n' +
      '转换命令: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in old.pem -out new.pem'
    );
  }
}

// ============ RSA-OAEP + AES-256-GCM 混合解密 ============

/**
 * 混合解密
 *
 * @param {string} cipherBase64 - base64 编码的混合密文
 * @param {string} rsaPrivateKeyPem - RSA 私钥 (PEM 格式)
 * @returns {Promise<string>} 解密后的明文
 */
async function hybridDecrypt(cipherBase64, rsaPrivateKeyPem) {
  // 1. base64 → Uint8Array
  const packed = Uint8Array.from(atob(cipherBase64), c => c.charCodeAt(0));

  // 2. 拆包: encKeyLen(2, big-endian) + encryptedAesKey(N) + iv(12) + authTag(16) + ciphertext
  const encKeyLen = (packed[0] << 8) | packed[1];
  let offset = 2;

  const encryptedAesKey = packed.slice(offset, offset + encKeyLen);
  offset += encKeyLen;

  const iv = packed.slice(offset, offset + 12);
  offset += 12;

  const authTag = packed.slice(offset, offset + 16);
  offset += 16;

  const ciphertext = packed.slice(offset);

  // 3. RSA-OAEP 私钥解密 AES 密钥
  const rsaKey = await importRsaPrivateKey(rsaPrivateKeyPem);
  const aesKeyBuffer = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    rsaKey,
    encryptedAesKey,
  );

  // 4. 导入 AES 密钥
  const aesKey = await crypto.subtle.importKey(
    'raw',
    aesKeyBuffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // 5. AES-256-GCM 解密正文 (Web Crypto 要求 authTag 附在 ciphertext 后面)
  const ciphertextWithTag = new Uint8Array(ciphertext.length + authTag.length);
  ciphertextWithTag.set(ciphertext);
  ciphertextWithTag.set(authTag, ciphertext.length);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    aesKey,
    ciphertextWithTag,
  );

  return new TextDecoder('utf-8').decode(plainBuffer);
}

// ============ 消息处理 ============

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ===== Content Script 请求解密 =====
  if (message.type === 'DECRYPT_CIPHER') {
    (async () => {
      try {
        let config = await getConfig();

        if (!config.enabled || !config.autoDecrypt) {
          return { success: false, reason: 'disabled' };
        }

        // 确保私钥已加载
        try {
          config = await ensurePrivateKey(config);
        } catch (err) {
          if (err.message === 'no_token') {
            return { success: false, reason: 'no_token' };
          }
          return { success: false, reason: `密钥加载失败: ${err.message}` };
        }

        const plaintext = await hybridDecrypt(message.cipher, config.rsaPrivateKeyPem);
        return { success: true, plaintext };
      } catch (err) {
        console.error('[HXLoLi-NaGaMe] ❌ 解密失败:', err.message);
        return { success: false, reason: `解密失败: ${err.message}` };
      }
    })().then(sendResponse);
    return true; // 异步响应
  }

  // ===== 获取配置 (给 content script, 不暴露敏感信息) =====
  if (message.type === 'GET_CONFIG') {
    (async () => {
      const config = await getConfig();
      return {
        enabled: config.enabled,
        autoDecrypt: config.autoDecrypt,
        hasToken: !!config.githubToken,
        hasKey: !!config.rsaPrivateKeyPem,
        githubUser: config.githubUser || '',
      };
    })().then(sendResponse);
    return true;
  }

  // ===== Popup: 获取完整配置 =====
  if (message.type === 'GET_FULL_CONFIG') {
    (async () => {
      const config = await getConfig();
      // 不给 popup 发私钥原文，只告诉有没有
      return {
        enabled: config.enabled,
        autoDecrypt: config.autoDecrypt,
        githubToken: config.githubToken ? '***' : '', // 隐藏 token
        githubUser: config.githubUser,
        hasKey: !!config.rsaPrivateKeyPem,
        keyFetchedAt: config.keyFetchedAt,
        hasToken: !!config.githubToken,
      };
    })().then(sendResponse);
    return true;
  }

  // ===== Popup: 发起 GitHub Device Flow (一条龙: 启动 → 打开页面 → 后台轮询 → 拉私钥) =====
  if (message.type === 'START_GITHUB_AUTH') {
    (async () => {
      try {
        // 1. 启动 Device Flow
        const deviceFlowData = await startDeviceFlow();

        // 2. 将验证码写入 storage, popup 可以显示 (即使 popup 关了重开也能看到)
        await chrome.storage.local.set({
          authState: {
            status: 'pending',
            userCode: deviceFlowData.user_code,
            verificationUri: deviceFlowData.verification_uri,
            startedAt: Date.now(),
          }
        });

        // 3. 自动打开 GitHub 验证页面
        chrome.tabs.create({ url: deviceFlowData.verification_uri, active: true });

        // 4. 立即返回给 popup (popup 随时可以关闭了!)
        sendResponse({ success: true, user_code: deviceFlowData.user_code, verification_uri: deviceFlowData.verification_uri });

        // 5. 在后台持续轮询 (popup 关了也没关系)
        try {
          const token = await pollForToken(
            deviceFlowData.device_code,
            deviceFlowData.interval,
            deviceFlowData.expires_in,
          );

          // 验证 token 并获取用户名
          const username = await verifyToken(token);

          // 拉取私钥
          const config = await getConfig();
          config.githubToken = token;
          config.githubUser = username;

          let keyLoaded = false;
          let keyError = '';

          try {
            const pem = await fetchPrivateKey(token);
            config.rsaPrivateKeyPem = pem;
            config.keyFetchedAt = Date.now();
            keyLoaded = true;
          } catch (keyErr) {
            keyError = keyErr.message;
          }

          await setConfig(config);

          // 6. 写入 authState, popup (如果打开了) 通过 storage.onChanged 感知
          await chrome.storage.local.set({
            authState: {
              status: 'success',
              username,
              keyLoaded,
              keyError,
              completedAt: Date.now(),
            }
          });

          console.log(`[HXLoLi-NaGaMe] ✅ GitHub 授权成功: ${username}, 私钥: ${keyLoaded ? '已加载' : keyError}`);

        } catch (pollErr) {
          await chrome.storage.local.set({
            authState: {
              status: 'error',
              error: pollErr.message,
              completedAt: Date.now(),
            }
          });
          console.error('[HXLoLi-NaGaMe] ❌ GitHub 授权失败:', pollErr.message);
        }

      } catch (err) {
        sendResponse({ success: false, error: err.message });
        await chrome.storage.local.set({
          authState: {
            status: 'error',
            error: err.message,
            completedAt: Date.now(),
          }
        });
      }
    })();
    return true; // 异步响应
  }

  // ===== Popup: 手动设置 Token (备用方式: Fine-grained PAT) =====
  if (message.type === 'SET_GITHUB_TOKEN') {
    (async () => {
      try {
        const token = message.token.trim();
        if (!token) {
          // 清除 token 和相关数据
          const config = await getConfig();
          config.githubToken = '';
          config.githubUser = '';
          config.rsaPrivateKeyPem = '';
          config.keyFetchedAt = 0;
          await setConfig(config);
          return { success: true, action: 'cleared' };
        }

        // 验证 token
        const username = await verifyToken(token);

        const config = await getConfig();
        config.githubToken = token;
        config.githubUser = username;

        // 拉取私钥
        try {
          const pem = await fetchPrivateKey(token);
          config.rsaPrivateKeyPem = pem;
          config.keyFetchedAt = Date.now();
          await setConfig(config);
          return { success: true, username, keyLoaded: true };
        } catch (keyErr) {
          await setConfig(config);
          return { success: true, username, keyLoaded: false, keyError: keyErr.message };
        }
      } catch (err) {
        return { success: false, error: err.message };
      }
    })().then(sendResponse);
    return true;
  }

  // ===== Popup: 登出 =====
  if (message.type === 'LOGOUT') {
    (async () => {
      const config = await getConfig();
      config.githubToken = '';
      config.githubUser = '';
      config.rsaPrivateKeyPem = '';
      config.keyFetchedAt = 0;
      await setConfig(config);
      return { success: true };
    })().then(sendResponse);
    return true;
  }

  // ===== Popup: 更新开关设置 =====
  if (message.type === 'UPDATE_SETTINGS') {
    (async () => {
      const config = await getConfig();
      if (message.enabled !== undefined) config.enabled = message.enabled;
      if (message.autoDecrypt !== undefined) config.autoDecrypt = message.autoDecrypt;
      await setConfig(config);
      return { success: true };
    })().then(sendResponse);
    return true;
  }

  // ===== Popup: 刷新私钥 (强制重新拉取) =====
  if (message.type === 'REFRESH_KEY') {
    (async () => {
      try {
        const config = await getConfig();
        if (!config.githubToken) {
          return { success: false, error: '请先授权 GitHub' };
        }

        const pem = await fetchPrivateKey(config.githubToken);
        config.rsaPrivateKeyPem = pem;
        config.keyFetchedAt = Date.now();
        await setConfig(config);
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    })().then(sendResponse);
    return true;
  }

  // ===== 解密状态更新 (badge 显示) =====
  if (message.type === 'DECRYPT_STATUS') {
    if (sender.tab?.id) {
      chrome.action.setBadgeText({
        tabId: sender.tab.id,
        text: message.decrypted ? '✓' : (message.protected ? '🔒' : '')
      }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({
        tabId: sender.tab.id,
        color: message.decrypted ? '#22c55e' : '#8b5cf6'
      }).catch(() => {});
    }
  }
});
