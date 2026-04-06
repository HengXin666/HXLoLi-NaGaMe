#!/usr/bin/env node
/**
 * 生成简单的 PNG 图标占位文件
 * 实际使用时请替换为真正的图标
 *
 * 这里生成 1x1 像素的紫色 PNG 作为占位
 * 正式使用请打开 icons/generate-icons.html 在浏览器中生成
 */

import { writeFileSync } from 'fs';

// 最简单的 PNG: 1x1 紫色像素
// 实际项目中, 建议:
// 1. 打开 generate-icons.html 在浏览器中生成
// 2. 或使用任意图片编辑器制作

const sizes = [16, 32, 48, 128];

// 1x1 紫色 PNG (手工构造)
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,  // PNG signature
]);

console.log('⚠️  请使用以下方式之一生成图标:');
console.log('');
console.log('  方式 1: 在浏览器中打开 icons/generate-icons.html');
console.log('  方式 2: 使用图片编辑器手动创建');
console.log('  方式 3: 从 HXLoLi 的 logo 裁剪');
console.log('');
console.log('需要的图标尺寸: 16x16, 32x32, 48x48, 128x128');
console.log('文件命名: icon16.png, icon32.png, icon48.png, icon128.png');
console.log('         icon16-active.png, icon32-active.png (解密成功状态)');

// 创建空的 placeholder 文件
for (const size of sizes) {
  const path = `icons/icon${size}.png`;
  console.log(`📝 请创建: ${path} (${size}x${size})`);
}
