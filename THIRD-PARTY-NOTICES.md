# 第三方声明与出处

本插件是 **PI-Desktop 的移植版**，功能规格来自下面这个 DSH 插件；代码是为 PI-Desktop 的
插件 API 重新实现的（DSH 侧的 40 条 `ctx.webServer.register` HTTP 路由在这里改写成了
`onPanelInvoke` 的通道表，面板 UI 从零编写），没有复制其源码文件。

## 上游项目

| 项 | 内容 |
|---|---|
| 项目 | source-code-mgmt — DSH 源代码管理插件 |
| 仓库 | https://github.com/Zhucy123/source-code-mgmt |
| 作者 | Zhucy123（GitHub） |
| 许可 | MIT（见其 `package.json` 的 `"license": "MIT"` 与 README 末尾的 `## License` 段） |

## 关于上游许可声明的说明

上游仓库**没有 LICENSE 文件**，`package.json` 也没有 `author` / `repository` 字段，
README 的 License 段只写了 "MIT" 三个字，GitHub 因此未识别出许可证。

MIT 许可允许使用、修改与再分发，条件是随分发物保留版权声明与许可声明。由于上游未提供
具体的版权人署名行，本文件以「上游项目 + 仓库地址 + 其声明的 MIT 许可」作为该声明的
可保留形式，并把 MIT 全文附在下方。若上游作者后续补充 LICENSE 文件或提出具体署名要求，
以作者的要求为准。

## MIT 许可全文（适用于上游项目）

```
MIT License

Copyright (c) Zhucy123

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 本移植版自身的许可

MIT（见同目录 `LICENSE`）。本插件与上游作者无从属关系，也不代表其认可。
