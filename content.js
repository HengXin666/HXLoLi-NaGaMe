/**
 * HXLoLi-NaGaMe - Content Script v3
 *
 * 核心流程:
 *   1. 检测页面 DOM 中的 [data-hx-protected] 元素
 *   2. 读取 data-hx-cipher 中的 base64 密文
 *   3. 发送给 Background Service Worker 进行混合解密
 *   4. 接收解密后的 Markdown 明文
 *   5. 渲染为 HTML 并通过 CustomEvent 注入页面
 *
 * 安全:
 *   - Content Script 不持有密钥
 *   - 不持有 GitHub Token
 *   - 只负责转发密文给 Background 并接收明文结果
 *   - 解密算法完全在 Background 中
 *   - 零网络请求: 密文已在 DOM 中, 解密纯本地完成
 *
 * 兼容: Chrome + Firefox (通过 browser-polyfill.js)
 */

/* global chrome */

(function () {
  'use strict';

  const PROTECTED_MAGIC = 'HXLOLI_PROTECTED_V3';
  let lastUrl = location.href;
  let processedInstances = new Set();

  // ============ Markdown → HTML 渲染 ============

  function markdownToHtml(md) {
    // 移除 frontmatter
    let content = md.replace(/^---\n[\s\S]*?\n---\n?/, '');

    // 代码块 (最先处理)
    const codeBlocks = [];
    content = content.replace(/```(\w*)\s*\n([\s\S]*?)```/gm, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push(
        `<pre class="prism-code language-${lang || 'text'}" style="background-color: rgb(40,44,52); color: rgb(171,178,191);"><code class="codeBlockLines">${escapeHtml(code.trimEnd())}</code></pre>`
      );
      return `\x00CODE${idx}\x00`;
    });

    // 行内代码
    content = content.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // 标题 (h1-h6)
    content = content.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, text) => {
      const level = hashes.length;
      const id = text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
      return `<h${level} id="${id}">${text}</h${level}>`;
    });

    // 图片
    content = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" style="max-width:100%"/>');

    // 链接
    content = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // 加粗+斜体
    content = content.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    content = content.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    content = content.replace(/\*(.+?)\*/g, '<em>$1</em>');
    content = content.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // 引用块
    content = content.replace(/^>\s?(.+)$/gm, '<blockquote><p>$1</p></blockquote>');
    content = content.replace(/<\/blockquote>\s*<blockquote>/g, '\n');

    // 表格
    content = content.replace(/((?:^\|.+\|$\n?)+)/gm, (tableBlock) => {
      const rows = tableBlock.trim().split('\n');
      if (rows.length < 2) return tableBlock;

      let html = '<div class="table-wrapper" style="overflow-x:auto;"><table>\n';
      const headerCells = rows[0].split('|').filter(c => c.trim());
      html += '<thead><tr>';
      for (const cell of headerCells) {
        html += `<th>${cell.trim()}</th>`;
      }
      html += '</tr></thead>\n<tbody>';
      for (let i = 2; i < rows.length; i++) {
        const cells = rows[i].split('|').filter(c => c.trim());
        if (cells.length === 0) continue;
        html += '<tr>';
        for (const cell of cells) {
          html += `<td>${cell.trim()}</td>`;
        }
        html += '</tr>\n';
      }
      html += '</tbody></table></div>';
      return html;
    });

    // 无序列表
    content = content.replace(/^(\s*)[-*+]\s+(.+)$/gm, (_, indent, text) => {
      return `<li>${text}</li>`;
    });
    content = content.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

    // 有序列表
    content = content.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

    // 水平线
    content = content.replace(/^---+$/gm, '<hr/>');
    content = content.replace(/^\*\*\*+$/gm, '<hr/>');

    // 段落
    content = content.replace(/^(?!<[a-z/]|<!\-\-|\x00CODE)((?!^\s*$).+)$/gm, '<p>$1</p>');

    // 恢复代码块
    content = content.replace(/\x00CODE(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);

    // 清理多余空行
    content = content.replace(/\n{3,}/g, '\n\n');

    return content;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ============ 页面检测与解密 ============

  function findProtectedMarkers() {
    return Array.from(document.querySelectorAll('[data-hx-protected="true"]'));
  }

  async function processProtectedMarker(marker) {
    const cipher = marker.dataset.hxCipher;
    const magic = marker.dataset.hxMagic;
    const instanceId = marker.dataset.hxInstance;

    if (!cipher || !magic || magic !== PROTECTED_MAGIC) return;
    if (!instanceId) return;
    if (processedInstances.has(instanceId)) return;
    processedInstances.add(instanceId);

    // 通知 badge: 检测到受保护页面
    chrome.runtime.sendMessage({ type: 'DECRYPT_STATUS', protected: true, decrypted: false });

    // 通知页面组件: 正在解密
    window.dispatchEvent(new CustomEvent('hxloli-decrypting', {
      detail: {
        type: 'HXLOLI_DECRYPTING',
        instanceId,
        message: '正在解密...',
      }
    }));

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'DECRYPT_CIPHER',
        cipher,
      });

      if (!response?.success) {
        const reason = response?.reason || '未知错误';
        console.log(`[HXLoLi-NaGaMe] ⚠️ 解密失败: ${reason}`);
        return;
      }

      console.log(`[HXLoLi-NaGaMe] ✅ 解密成功 (${response.plaintext.length} chars)`);

      // Markdown → HTML
      const html = markdownToHtml(response.plaintext);

      // 通过 CustomEvent 发送给 ProtectedPage React 组件
      window.dispatchEvent(new CustomEvent('hxloli-decrypted', {
        detail: {
          type: 'HXLOLI_DECRYPTED',
          instanceId,
          html,
        }
      }));

      // 通知 badge: 解密成功
      chrome.runtime.sendMessage({ type: 'DECRYPT_STATUS', protected: true, decrypted: true });

    } catch (err) {
      console.error(`[HXLoLi-NaGaMe] ❌ 处理失败:`, err);
    }
  }

  async function scanAndProcess() {
    const markers = findProtectedMarkers();

    if (markers.length === 0) {
      chrome.runtime.sendMessage({ type: 'DECRYPT_STATUS', protected: false, decrypted: false });
      return;
    }

    for (const marker of markers) {
      await processProtectedMarker(marker);
    }
  }

  // ============ 监听 React 组件通知 ============

  function listenForProtectedPages() {
    window.addEventListener('hxloli-protected-page', async (e) => {
      const detail = e.detail;
      if (detail?.type === 'HXLOLI_PROTECTED_PAGE' && detail?.instanceId) {
        console.log(`[HXLoLi-NaGaMe] 📡 收到受保护页面通知: ${detail.instanceId}`);
        processedInstances.delete(detail.instanceId);
        setTimeout(scanAndProcess, 100);
      }
    });
  }

  // ============ SPA 路由变化 ============

  function observeRouteChanges() {
    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        processedInstances.clear();
        setTimeout(scanAndProcess, 600);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('popstate', () => {
      processedInstances.clear();
      setTimeout(scanAndProcess, 600);
    });

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      processedInstances.clear();
      setTimeout(scanAndProcess, 600);
    };

    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      processedInstances.clear();
      setTimeout(scanAndProcess, 600);
    };
  }

  // ============ 来自 popup 的重试消息 ============
  chrome.runtime.onMessage?.addListener((message) => {
    if (message.type === 'RETRY_DECRYPT') {
      processedInstances.clear();
      scanAndProcess();
    }
  });

  // ============ 初始化 ============

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(scanAndProcess, 500);
      observeRouteChanges();
      listenForProtectedPages();
    });
  } else {
    setTimeout(scanAndProcess, 500);
    observeRouteChanges();
    listenForProtectedPages();
  }
})();
