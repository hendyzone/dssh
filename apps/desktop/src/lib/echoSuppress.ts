/**
 * 抑制本地注入命令在远端 tty 上的回显。
 *
 * 连接后我们把 OSC 7 钩子命令写入 shell，远端 tty / ZLE 会把这段文本
 * 回显回来（其中可能夹杂 ZLE 重绘、语法高亮等产生的 ANSI 转义序列，
 * 且回显可能跨多个数据事件被截断）。本模块在数据流中识别并剔除这段
 * 固定文本：
 *  - 匹配前先把转义序列从比对视图中剥离（但保留字节位置映射），
 *    命中后连同夹杂的转义序列一起从输出中删除；
 *  - 未命中时按“末尾最长前缀”保留疑似片段，其余立即放行，
 *    不会卡住或丢失正常输出；
 *  - flush() 用于超时兜底，把暂存内容原样放出。
 */

export interface EchoSuppressor {
  /** 处理一块远端输出，返回可以写给终端的字节（"" 表示暂存中） */
  process: (chunk: string) => string;
  /** 放弃抑制，把暂存内容全部放出 */
  flush: () => string;
  readonly active: boolean;
}

interface StripResult {
  /** 剥离转义序列后的纯文本 */
  plain: string;
  /** plain[i] 在原始字符串中的字节下标；map[plain.length] 为已解析末尾 */
  map: number[];
}

// 单条完整 ANSI 转义序列：CSI / OSC / 字符集选择 / 单字符 ESC 序列。
// 注意单字符兜底要排除 [ ] ( )，否则不完整的 CSI/OSC 前缀会被吃掉。
const ESC_RE =
  /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[@-Z\\^_])/;

function stripAnsi(s: string): StripResult {
  let plain = "";
  const map: number[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = s.slice(i).match(ESC_RE);
      if (m) {
        i += m[0].length;
        continue;
      }
      // 不完整或无法识别的转义序列：停在此处，留在 stash 等下一块
      break;
    }
    map.push(i);
    plain += s[i];
    i++;
  }
  map.push(i); // 哨兵：已解析字节末尾
  return { plain, map };
}

/** With a completion marker, expected is the short, stable command prefix. */
export function createEchoSuppressor(
  expected: string,
  completionMarker?: string,
): EchoSuppressor {
  let active = true;
  let stash = "";
  let echoStarted = false;

  const suppressor: EchoSuppressor = {
    process(chunk: string): string {
      if (!active) return chunk;
      stash += chunk;
      // The shell emits a unique OSC marker after initialization. Once the
      // prefix matches, line wrapping and ZLE redraws no longer affect filtering.
      if (completionMarker && echoStarted) {
        const end = stash.indexOf(completionMarker);
        if (end >= 0) {
          const out = "\r\x1b[2K" + stash.slice(end + completionMarker.length);
          active = false;
          stash = "";
          return out;
        }
        return stash.length > 65536 ? suppressor.flush() : "";
      }
      const { plain, map } = stripAnsi(stash);

      const idx = plain.indexOf(expected);
      if (completionMarker) {
        const end = stash.indexOf(completionMarker);
        if (end >= 0 && (idx < 0 || end < map[idx])) {
          // With tty echo disabled, preserve banner and all post-marker output.
          const out =
            stash.slice(0, end) + stash.slice(end + completionMarker.length);
          active = false;
          stash = "";
          return out;
        }
      }
      if (idx >= 0) {
        const startByte = map[idx];
        if (completionMarker) {
          const before = stash.slice(0, startByte);
          stash = stash.slice(startByte);
          echoStarted = true;
          return before + suppressor.process("");
        }
        const endByte = map[idx + expected.length - 1] + 1;
        const out = stash.slice(0, startByte) + stash.slice(endByte);
        active = false;
        stash = "";
        return out;
      }

      // 末尾可能是被截断的回显前缀，保留等待下一块拼接
      let keep = 0;
      const maxK = Math.min(plain.length, expected.length - 1);
      for (let k = maxK; k > 0; k--) {
        if (plain.endsWith(expected.slice(0, k))) {
          keep = k;
          break;
        }
      }
      const flushPlain = plain.length - keep;
      if (flushPlain <= 0 && !(completionMarker && plain.length === 0))
        return "";
      // Complete ANSI queries must reach the renderer immediately so the shell
      // can receive its reply. stripAnsi leaves incomplete sequences buffered.
      const cut = map[flushPlain];
      const out = stash.slice(0, cut);
      stash = stash.slice(cut);
      return out;
    },

    flush(): string {
      if (!active) return "";
      active = false;
      const out = stash;
      stash = "";
      return out;
    },

    get active() {
      return active;
    },
  };

  return suppressor;
}
