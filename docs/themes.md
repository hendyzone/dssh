# 主题配色

设置 → 外观支持深色、浅色、明暗混合分类与名称搜索。混合主题将工具面板和终端分别配色；不改变远端应用自行输出的 RGB 真彩色。

新增 15 套主题，总计 22 套。保留原有主题 ID，升级后不替换用户当前选择。新增预设包含 ANSI 16 色、背景、文字、光标及选区颜色。

## 参考来源

- One Dark Pro：<https://github.com/Binaryify/OneDark-Pro>，终端 ANSI 颜色参考官方 `src/themes/data/oneDarkPro.ts`。原项目 MIT；Copyright (c) Binaryify。
- Monokai Pro (CE)：<https://monokai.pro/contribute>，参考官方默认配色；Monokai Pro 色彩与名称归 Monokai 所有。本项目的界面适配不是官方插件，不包含图标包或其他付费滤镜。
- Monokai Classic：经典 Monokai 配色适配，<https://monokai.pro>。
- Dracula：<https://github.com/dracula/dracula-theme> 公布的 OSS 色板；原项目 MIT，Copyright (c) Zeno Rocha。
- Solarized：<https://github.com/altercation/solarized>，Copyright (c) 2011 Ethan Schoonover，MIT。

Paper、Rose Paper、Ocean、Forest、Ink 为 dssh 自定义配色。Emerald、Studio、Paper Night、Rose Night 是本项目设计的明暗组合。UI 层级色、部分对比度和 ANSI 映射针对 SSH 客户端进行了适配。

## 混合主题

- Emerald：中性浅色面板、绿色强调、Monokai Classic 深色终端。
- Studio：中性浅色面板、蓝色强调、One Dark Pro 终端。
- Paper Night：Solarized 暖纸面板与深青终端。
- Rose Night：玫瑰纸面板与 Dracula 终端。

## MIT 来源许可

上述 MIT 来源的版权声明见各条目，以下许可适用于这些来源：

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
