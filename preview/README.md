# 本地视觉预览（非插件运行时）

这个目录只用于开发时看页面，不进入插件的加载路径，也不随插件安装。

```powershell
node preview/server.mjs
# http://127.0.0.1:8791/?mode=live
```

- `mode`：`live | cached | unconfigured | error | no-ledger`
- `&panel=config`：直接看内联配置表单
- 页面顶部有醒目提示：**DeepSeek 余额是示例数据**；账本数字来自本机真实的
  `~/.dsh/dsh-usage/usage-ledger.json`（`no-ledger` 模式除外）。

## 为什么 vendored React

DSH 的页面运行时由外壳提供 React，预览页没有外壳，所以这里放了 React 17 的
UMD 生产构建（`vendor/react.production.min.js`、`vendor/react-dom.production.min.js`，
均带 `@license React v17.0.2` 头，MIT）。插件本身不依赖这两个文件，也不使用
React 18/19 专属 API；预览只为了看布局和状态文案。

## 实现

`server.mjs` 用 Node 内置模块起一个只监听 `127.0.0.1` 的静态/JSON 服务：

- `/`、`/client.js`、`/vendor/*` 出文件；
- `/usage-panel/api/*` 返回与 Host 同形状的 snapshot（余额为示例值，账本复用
  `lib/ledger.js` 真实读取）；
- `preview.html` 用单槽 `window.__ModuleLoader__` stub + UMD React 渲染
  `__internals.UsagePage`。

只用于开发；生产路径永远是 DSH 自己的 module loader 与 React。
