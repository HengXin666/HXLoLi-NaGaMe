/**
 * HXLoLi-NaGaMe - 浏览器 API 兼容层
 *
 * 统一 Chrome (chrome.*) 和 Firefox (browser.*) 的 API 差异
 * Firefox 原生使用 Promise-based browser.* API
 * Chrome 使用 callback-based chrome.* API (MV3 中部分已支持 Promise)
 */

/* global globalThis, chrome, browser */

(function () {
  'use strict';

  // 如果 browser 已定义 (Firefox)，直接导出
  if (typeof globalThis.browser !== 'undefined' && globalThis.browser.runtime) {
    globalThis.EXT = globalThis.browser;
    return;
  }

  // Chrome: 直接用 chrome (MV3 大部分 API 已支持 Promise)
  if (typeof globalThis.chrome !== 'undefined' && globalThis.chrome.runtime) {
    globalThis.EXT = globalThis.chrome;
    return;
  }

  console.error('[HXLoLi-NaGaMe] 未检测到浏览器扩展 API');
})();
