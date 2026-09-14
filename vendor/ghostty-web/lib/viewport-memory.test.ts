import { expect, test } from 'bun:test';
import { Ghostty } from './ghostty';
import { RowCellsData } from './types';

for (let failAt = 1; failAt <= 11; failAt++) {
  test(`viewport cleans up when scratch allocation ${failAt} fails`, async () => {
    const ghostty = await Ghostty.load();
    const term = ghostty.createTerminal(4, 2);
    term.write('e\u0301');
    term.update();
    const internal = term as any;
    const original = internal.exports;
    const update = internal.update;
    // Isolate the viewport's scratch allocations from render-state refresh.
    internal.update = () => 0;
    const live = new Set<number>();
    let allocations = 0;
    const allocate = (fn: () => number) => {
      if (++allocations === failAt) return 0;
      const ptr = fn();
      live.add(ptr);
      return ptr;
    };
    internal.exports = {
      ...original,
      ghostty_wasm_alloc_u8_array: (size: number) =>
        allocate(() => original.ghostty_wasm_alloc_u8_array(size)),
      ghostty_wasm_alloc_u8: () => allocate(() => original.ghostty_wasm_alloc_u8()),
      ghostty_wasm_free_u8_array(ptr: number, size: number) {
        expect(ptr).not.toBe(0);
        live.delete(ptr);
        original.ghostty_wasm_free_u8_array(ptr, size);
      },
      ghostty_wasm_free_u8(ptr: number) {
        expect(ptr).not.toBe(0);
        live.delete(ptr);
        original.ghostty_wasm_free_u8(ptr);
      },
    };
    try {
      expect(() => term.getViewport()).toThrow(/allocate/);
      expect(live.size).toBe(0);
      internal.exports = original;
      expect(term.getViewport()[0]?.codepoint).toBe(101);
    } finally {
      internal.exports = original;
      internal.update = update;
      term.free();
    }
  });
}

test('viewport allocates space for every codepoint in a grapheme before WASM writes', async () => {
  const ghostty = await Ghostty.load();
  const term = ghostty.createTerminal(40, 6);
  const internal = term as any;
  const original = internal.exports;
  const allocations = new Map<number, number>();
  let checkedClusters = 0;
  internal.exports = {
    ...original,
    ghostty_wasm_alloc_u8_array(size: number) {
      const ptr = original.ghostty_wasm_alloc_u8_array(size);
      allocations.set(ptr, size);
      return ptr;
    },
    ghostty_wasm_free_u8_array(ptr: number, size: number) {
      allocations.delete(ptr);
      original.ghostty_wasm_free_u8_array(ptr, size);
    },
    ghostty_render_state_row_cells_get(handle: number, kind: number, ptr: number) {
      if (kind === RowCellsData.GRAPHEMES_BUF) {
        const lengthPtr = original.ghostty_wasm_alloc_u8_array(4);
        original.ghostty_render_state_row_cells_get(handle, RowCellsData.GRAPHEMES_LEN, lengthPtr);
        const length = new DataView(internal.memory.buffer).getUint32(lengthPtr, true);
        original.ghostty_wasm_free_u8_array(lengthPtr, 4);
        expect(allocations.get(ptr) ?? 0).toBeGreaterThanOrEqual(length * 4);
        if (length > 1) checkedClusters++;
      }
      return original.ghostty_render_state_row_cells_get(handle, kind, ptr);
    },
  };
  try {
    for (let i = 0; i < 30; i++) {
      term.write(`中文 e\u0301 👨‍👩‍👧‍👦 ${'a' + '\u0301'.repeat(24)}\r\n`);
      const cells = term.getViewport();
      expect(cells.length).toBe(240);
    }
    expect(checkedClusters).toBeGreaterThan(30);
    expect(allocations.size).toBe(0);
  } finally {
    internal.exports = original;
    term.free();
  }
});
