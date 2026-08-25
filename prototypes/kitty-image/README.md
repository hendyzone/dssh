# M0 验证 demo：Kitty 图片协议可行性

验证 dssh 的最高风险项：在浏览器终端（ghostty-web）里跑 shell/pi，能否内联显示图片。

## 运行

```bash
npm install
npm run gen-image   # 生成测试 PNG（首次）
npm run dev         # 同时起 Vite(5173) 和 pty-ws 桥(39871)
# 打开 http://localhost:5173
```

## 验证清单

- [ ] 点「显示测试图片」→ 终端内应出现一张 128x128 渐变图
- [ ] 在终端里运行 `pi`，让它读取/生成图片（如让它看一张截图），观察图片是否内联显示
- [ ] server 日志中的 `[kitty]` 行能看到 pi 的能力探测查询（`a=q`）是否发出——若 pi 没发查询说明探测未通过，需要在集成层代答

## 冒烟测试（无浏览器）

```bash
node server/smoke-test.mjs   # 验证 ws 桥与 Kitty APC 序列回传
```

## 结构

```
server/index.mjs        # ws ↔ node-pty 桥（后续换 ssh2，字节协议不变）
server/test-image.sh    # 通过 Kitty graphics protocol 显示图片（分块传输）
server/gen-test-png.mjs # 生成测试 PNG
src/terminal.ts         # ghostty-web 封装（WASM 初始化、ws 绑定）
```

## 已知事项

- ghostty-web 使用 `vendor/ghostty-web`（rcarmo fork v0.9.6，Kitty graphics 已接入 Canvas 渲染器）
- 渲染器固定 Canvas；WebGL 路径不支持 Kitty graphics
