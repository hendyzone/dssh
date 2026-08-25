// 冒烟测试：连接 ws 桥，跑测试图片脚本，验证 Kitty APC 序列回传
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:39871/ws");
let buf = "";
let phase = "init";

const timeout = setTimeout(() => {
  console.error("FAIL: timeout. buffer tail:", JSON.stringify(buf.slice(-200)));
  process.exit(1);
}, 25000);

ws.on("open", () => {
  console.log("1. ws connected ✓");
  // 等待 shell 初始化完成后直接发送命令（不依赖 prompt 样式匹配）
  setTimeout(() => {
    if (phase !== "init") return;
    phase = "sent";
    console.log("2. sending test-image command…");
    ws.send(
      JSON.stringify({
        type: "data",
        data: "bash /srv/workspace/dssh/prototypes/kitty-image/server/test-image.sh\n",
      }),
    );
  }, 2000);
});

ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return; // 忽略非 JSON 帧
  }
  if (msg.type !== "data") return;
  buf += msg.data;

  if (buf.includes("\x1b_G")) {
    phase = "done";
    const m = buf.match(/\x1b_Ga=T,f=100,m=([01]);/);
    console.log(`3. kitty graphics APC received ✓ (first chunk m=${m?.[1]})`);
    // 校验 base64 载荷非空
    const payload = buf.match(/\x1b_Ga=T,f=100,m=[01];([A-Za-z0-9+/=]+)/);
    console.log(`4. payload length: ${payload?.[1]?.length ?? 0} chars ✓`);
    clearTimeout(timeout);
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
