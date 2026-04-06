/**
 * HXLoLi-NaGaMe - Content Script v3
 *
 * 核心流程:
 *   1. 检测页面 DOM 中的 [data-hx-protected] 元素
 *   2. 读取 data-hx-cipher 中的 base64 密文
 *   3. 发送给 Background Service Worker 进行混合解密
 *   4. 接收解密后的 Markdown 明文
 *   5. 渲染为 HTML 并 **直接替换 DOM** (不依赖 React state)
 *
 * 为什么直接替换 DOM:
 *   - Content Script 运行在 isolated world, React 运行在 main world
 *   - CustomEvent.detail 和 MutationObserver 跨 world 均不可靠
 *   - 唯一共享的是 DOM 树, 直接操作 DOM 是 100% 可靠的方式
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

  console.log('[HXLoLi-NaGaMe] 🚀 Content Script 已注入到:', location.href);

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

  // ============ 直接 DOM 替换 (核心渲染) ============

  /**
   * 找到 marker 所在的 ProtectedPage 容器, 直接替换整个锁定界面为解密后的 HTML。
   * 这是唯一 100% 可靠的方式 —— Content Script 与页面共享 DOM 树。
   */
  function replaceWithDecryptedContent(marker, html) {
    // marker 是 [data-hx-protected] 的 div, 它的父元素是 React 的 protectedContainer
    // DOM 结构: <div class="protectedContainer"> → <div data-hx-protected .../> + <div class="lockCard">...</div>
    const container = marker.closest('[class*="protectedContainer"]') || marker.parentElement;
    if (!container) {
      console.warn('[HXLoLi-NaGaMe] ⚠️ 找不到 protectedContainer, 回退到 marker.parentElement');
      return;
    }

    // 构建解密后的 DOM
    const decryptedWrapper = document.createElement('div');
    decryptedWrapper.setAttribute('data-hx-nagame-decrypted', 'true');
    decryptedWrapper.innerHTML = `<div class="markdown">${html}</div>`;

    // 替换整个容器
    container.replaceWith(decryptedWrapper);
    console.log('[HXLoLi-NaGaMe] 🎉 已直接替换 DOM, 解密内容已显示');

    // 解密后动态生成 TOC (Docusaurus 构建时提取不到加密内容的标题)
    injectTOC(decryptedWrapper);
  }

  /**
   * 从解密后的 HTML 中提取 h2-h6 标题, 动态生成 TOC 并注入到 Docusaurus 的右侧目录栏。
   *
   * 关键问题:
   *   加密页面的 MDX 没有任何 ## 标题, 所以 Docusaurus 构建时 toc = []
   *   → BlogPostPage: `toc.length > 0 ? <TOC .../> : undefined` → toc 是 undefined
   *   → BlogLayout: `toc ? <div>{toc}</div> : <div />` → 右侧只有一个空的占位 div
   *   → DocItem: `canRender = !hidden && toc.length > 0` → 同理, 不渲染 TOC
   *
   *   因此页面中根本没有 .tableOfContents / .table-of-contents 等元素！
   *   我们需要找到右侧的空占位 div, 自行创建完整的 TOC DOM 结构。
   *
   * Docusaurus 正常 TOC 的 DOM:
   *   <div class="col" style="max-width: 21.75%">              ← 右侧列 (BlogLayout)
   *     <div class="tableOfContents_xxxx thin-scrollbar">       ← TOC 外层容器
   *       <ul class="table-of-contents table-of-contents__left-border">
   *         <li><a class="table-of-contents__link toc-highlight" href="#id">标题</a></li>
   *       </ul>
   *     </div>
   *   </div>
   *
   *   或者 (DocItem):
   *   <div class="col col--3">
   *     <div class="tableOfContents_xxxx thin-scrollbar">
   *       ...同上
   *     </div>
   *   </div>
   */
  function injectTOC(decryptedWrapper) {
    // 从解密内容中提取 h2-h6
    const headings = decryptedWrapper.querySelectorAll('h2, h3, h4, h5, h6');
    if (headings.length === 0) {
      console.log('[HXLoLi-NaGaMe] ℹ️ 解密内容中无标题, 跳过 TOC 注入');
      return;
    }

    // 策略 1: 页面已有 TOC 容器 (某些页面可能有非空 toc, 例如部分内容未加密)
    let tocUl = document.querySelector('.table-of-contents__left-border')
      || document.querySelector('ul.table-of-contents');

    if (tocUl) {
      tocUl.innerHTML = '';
      buildTOCList(tocUl, headings);
      setupTOCScrollSpy(tocUl, headings);
      console.log(`[HXLoLi-NaGaMe] 📑 已注入 TOC 到已有容器 (${headings.length} 个标题)`);
      return;
    }

    // 策略 2: 页面有 tableOfContents 外层但没有 ul (不太可能, 以防万一)
    let tocWrapper = document.querySelector('[class*="tableOfContents"]');
    if (tocWrapper) {
      const ul = document.createElement('ul');
      ul.className = 'table-of-contents table-of-contents__left-border';
      tocWrapper.appendChild(ul);
      buildTOCList(ul, headings);
      setupTOCScrollSpy(ul, headings);
      console.log(`[HXLoLi-NaGaMe] 📑 已注入 TOC 到已有 wrapper (${headings.length} 个标题)`);
      return;
    }

    // 策略 3 (核心): 完全没有 TOC 容器 — 加密页面 toc=[] 导致整个 TOC 组件未渲染
    // 需要找到右侧空列 div 并自行创建完整 TOC 结构

    // Blog 页面: BlogLayout 的右侧 <div class="col" style="max-width: 21.75%">
    // Doc 页面: DocItem 的 <div class="col col--3"> 或者根本没有右侧列
    const rightCol = findEmptyRightColumn();

    if (!rightCol) {
      console.log('[HXLoLi-NaGaMe] ℹ️ 未找到右侧列容器, 跳过 TOC 注入');
      return;
    }

    // 创建完整的 TOC 结构
    const tocContainer = document.createElement('div');
    tocContainer.className = 'thin-scrollbar';
    tocContainer.style.cssText = 'max-height: calc(100vh - (var(--ifm-navbar-height) + 2rem)); overflow-y: auto; position: sticky; top: calc(var(--ifm-navbar-height) + 1rem);';

    const ul = document.createElement('ul');
    ul.className = 'table-of-contents table-of-contents__left-border';
    tocContainer.appendChild(ul);

    buildTOCList(ul, headings);
    rightCol.appendChild(tocContainer);
    setupTOCScrollSpy(ul, headings);

    console.log(`[HXLoLi-NaGaMe] 📑 已创建并注入完整 TOC (${headings.length} 个标题)`);
  }

  /**
   * 找到右侧的空列 div (BlogLayout 或 DocItem 渲染的占位列)
   *
   * BlogLayout 结构:
   *   <main class="col"> → <div class="row"> → [<div class="col" 内容>, <div class="col" 空占位>]
   *
   * DocItem 结构:
   *   <div class="row"> → [<div class="col docItemCol">, (可能没有右侧列)]
   */
  function findEmptyRightColumn() {
    // Blog 页面: 找到 main.col 下 row 中的最后一个空 .col
    const mainRow = document.querySelector('main.col > .row');
    if (mainRow) {
      const cols = mainRow.querySelectorAll(':scope > .col');
      if (cols.length >= 2) {
        const rightCol = cols[cols.length - 1];
        // 确认这是空的占位列 (没有实际子元素或只有空白)
        if (rightCol.children.length === 0 || rightCol.textContent.trim() === '') {
          return rightCol;
        }
      }
    }

    // Doc 页面: 找到 .row 中的 col--3, 或者在 row 末尾添加一个
    const docRow = document.querySelector('.row');
    if (docRow) {
      const col3 = docRow.querySelector('.col--3');
      if (col3 && col3.children.length === 0) {
        return col3;
      }

      // DocItem 如果 canRender=false, 根本不会渲染右侧列
      // 检查是否是 doc 页面 (有 docItemCol)
      const docItemCol = docRow.querySelector('[class*="docItemCol"]');
      if (docItemCol) {
        const newCol = document.createElement('div');
        newCol.className = 'col col--3';
        docRow.appendChild(newCol);
        return newCol;
      }
    }

    return null;
  }

  /**
   * 简单的滚动监听: 高亮当前可见的标题对应的 TOC 链接
   */
  function setupTOCScrollSpy(tocUl, headings) {
    const ACTIVE_CLASS = 'table-of-contents__link--active';

    function updateActive() {
      const links = tocUl.querySelectorAll('.table-of-contents__link');
      let activeIdx = 0;
      const offset = 100; // navbar 高度 + 一些余量

      for (let i = 0; i < headings.length; i++) {
        const rect = headings[i].getBoundingClientRect();
        if (rect.top <= offset) {
          activeIdx = i;
        }
      }

      links.forEach((link, i) => {
        if (i === activeIdx) {
          link.classList.add(ACTIVE_CLASS);
        } else {
          link.classList.remove(ACTIVE_CLASS);
        }
      });
    }

    // 初始化
    updateActive();

    // 节流滚动监听
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          updateActive();
          ticking = false;
        });
        ticking = true;
      }
    });
  }

  /**
   * 根据标题层级构建嵌套的 TOC <li> 列表。
   * Docusaurus 的 TOC 格式:
   *   <li>
   *     <a class="table-of-contents__link toc-highlight" href="#id">标题文字</a>
   *     <ul>  ← 子级标题
   *       <li>...</li>
   *     </ul>
   *   </li>
   */
  function buildTOCList(container, headings) {
    const LINK_CLASS = 'table-of-contents__link toc-highlight';

    // 找到最小的标题级别作为顶级
    let minLevel = 6;
    for (const h of headings) {
      const level = parseInt(h.tagName.charAt(1));
      if (level < minLevel) minLevel = level;
    }

    // 用栈来维护嵌套层级
    let currentList = container;
    let currentLevel = minLevel;
    const listStack = [{ list: container, level: minLevel }];

    for (const h of headings) {
      const level = parseInt(h.tagName.charAt(1));
      const id = h.id || h.textContent.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');

      // 确保 heading 有 id (用于锚点跳转)
      if (!h.id) h.id = id;

      if (level > currentLevel) {
        // 需要向下嵌套
        const subUl = document.createElement('ul');
        const lastLi = currentList.querySelector(':scope > li:last-child');
        if (lastLi) {
          lastLi.appendChild(subUl);
        } else {
          currentList.appendChild(subUl);
        }
        listStack.push({ list: subUl, level });
        currentList = subUl;
        currentLevel = level;
      } else if (level < currentLevel) {
        // 回退到上层
        while (listStack.length > 1 && listStack[listStack.length - 1].level > level) {
          listStack.pop();
        }
        currentList = listStack[listStack.length - 1].list;
        currentLevel = listStack[listStack.length - 1].level;
      }

      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = LINK_CLASS;
      a.href = `#${id}`;
      a.textContent = h.textContent;
      li.appendChild(a);
      currentList.appendChild(li);
    }
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

      // ====== 直接替换 DOM (最可靠: 不依赖 React state / CustomEvent / MutationObserver) ======
      // Content Script 和 React 组件分属 isolated world 和 main world,
      // CustomEvent.detail 和 MutationObserver 在跨 world 时都不可靠。
      // 唯一 100% 可靠的方式: 直接操作共享的 DOM 树。
      replaceWithDecryptedContent(marker, html);

      // 通知 badge: 解密成功
      chrome.runtime.sendMessage({ type: 'DECRYPT_STATUS', protected: true, decrypted: true });

    } catch (err) {
      console.error(`[HXLoLi-NaGaMe] ❌ 处理失败:`, err);
    }
  }

  async function scanAndProcess() {
    const markers = findProtectedMarkers();
    console.log(`[HXLoLi-NaGaMe] 🔍 扫描页面, 找到 ${markers.length} 个受保护标记`);

    if (markers.length === 0) {
      chrome.runtime.sendMessage({ type: 'DECRYPT_STATUS', protected: false, decrypted: false });
      return;
    }

    for (const marker of markers) {
      console.log(`[HXLoLi-NaGaMe] 📋 处理标记: magic=${marker.dataset.hxMagic}, instance=${marker.dataset.hxInstance}, cipher长度=${(marker.dataset.hxCipher || '').length}`);
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

  /**
   * 多次扫描策略: Docusaurus 是 SPA, React 组件可能需要额外时间渲染,
   * 单次 500ms 延迟不够可靠。多次重试直到找到标记或超时。
   */
  let initialScanCount = 0;
  const INITIAL_SCAN_DELAYS = [500, 1000, 2000, 4000]; // 最多 4 次初始扫描

  async function initialScan() {
    const markers = findProtectedMarkers();
    console.log(`[HXLoLi-NaGaMe] 🔍 初始扫描 #${initialScanCount + 1}, 找到 ${markers.length} 个标记`);

    if (markers.length > 0) {
      await scanAndProcess();
      return; // 找到了, 停止重试
    }

    // 没找到标记, 安排下次重试
    initialScanCount++;
    if (initialScanCount < INITIAL_SCAN_DELAYS.length) {
      const nextDelay = INITIAL_SCAN_DELAYS[initialScanCount];
      console.log(`[HXLoLi-NaGaMe] ⏳ 未找到标记, ${nextDelay}ms 后重试...`);
      setTimeout(initialScan, nextDelay);
    } else {
      console.log('[HXLoLi-NaGaMe] ℹ️ 初始扫描完毕, 未检测到受保护内容 (将继续监听路由变化和 React 通知)');
      chrome.runtime.sendMessage({ type: 'DECRYPT_STATUS', protected: false, decrypted: false });
    }
  }

  function startup() {
    setTimeout(initialScan, INITIAL_SCAN_DELAYS[0]);
    observeRouteChanges();
    listenForProtectedPages();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startup);
  } else {
    startup();
  }
})();
