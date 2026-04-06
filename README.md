# HXLoLi-NaGaMe 🔐

> **NaGaMe (眺め)** = 凝望 — 只有「凝望者」才能看到隐藏的内容

HXLoLi 博客受保护页面自动解锁浏览器插件。

## 特性

- 🔓 **一键 GitHub 授权** — 无需手动管理密钥
- 🛡️ **RSA-OAEP + AES-256-GCM 混合加密** — 非对称安全
- 🦊 **Chrome + Firefox 双平台支持**
- 🔄 **跨设备同步** — 只需在新设备上授权 GitHub 即可
- 📱 **零配置** — 安装后点一个按钮就完成

## 工作原理

```
┌──────────────┐   GitHub OAuth    ┌──────────────┐
│  浏览器插件   │ ──── Token ────→ │   GitHub API  │
│ HXLoLi-NaGaMe│ ←── 私钥 PEM ──  │ HXLoLi-imouto │
└──────┬───────┘                   └──────────────┘
       │
       │ RSA 私钥解密
       │ AES 密钥
       ↓
┌──────────────┐
│  页面 DOM 中  │ → AES-256-GCM → 明文 Markdown → 渲染 HTML
│  的密文数据   │
└──────────────┘
```

1. 用户安装插件 → 点击「通过 GitHub 授权」
2. GitHub Device Flow: 自动打开 GitHub 页面 → 输入验证码 → 授权
3. 插件用 Token 从私有仓库 `HXLoLi-imouto` 拉取 RSA 私钥
4. 访问受保护页面 → 自动解密显示

**用户完全不需要知道 RSA 密钥的存在！**

## 安装

### Chrome

1. 下载本仓库
2. 打开 `chrome://extensions/`
3. 启用「开发者模式」
4. 点击「加载已解压的扩展程序」→ 选择本目录
5. 点击插件图标 → 通过 GitHub 授权

### Firefox

1. 下载本仓库
2. 打开 `about:debugging#/runtime/this-firefox`
3. 点击「临时载入附加组件」→ 选择本目录的 `manifest.json`
4. 点击插件图标 → 通过 GitHub 授权

## 安全模型

| 环节 | 说明 |
|------|------|
| CI (GitHub Actions) | 持有 **RSA 公钥** — 只能加密, 不能解密 |
| 浏览器插件 | 通过 GitHub Token 拉取 **RSA 私钥** — 缓存在本地 |
| GitHub Token | 仅有 `repo` scope, 只用于读取 `HXLoLi-imouto` |
| 密文传输 | 密文嵌入页面 DOM, **零网络请求**解密 |
| 明文 | 只存在于浏览器内存中, 不落盘 |

## 备用方案

如果不想使用 OAuth 授权, 也可以手动输入 GitHub Token:

1. 前往 [GitHub Settings > Fine-grained PAT](https://github.com/settings/tokens?type=beta)
2. 创建 Token, 仅授权 `HXLoLi-imouto` 仓库的 Contents 读取权限
3. 在插件 popup 底部展开「备用方案」→ 粘贴 Token

## 开发

```bash
# 修改代码后, 在 chrome://extensions/ 点击刷新按钮即可
```

## 前置条件

需要先设置好:
1. **私有仓库** `HXLoLi-imouto` — 存放 RSA 私钥和私密页面
2. **GitHub OAuth App** — 用于 Device Flow 授权
3. **RSA 密钥对** — 公钥配置在 CI, 私钥放在 HXLoLi-imouto

详见 [HXLoLi-Encrypted-Pages-Guide.md](../HXLoLi-Encrypted-Pages-Guide.md)
