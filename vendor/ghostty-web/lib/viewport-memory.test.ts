import { expect, test } from 'bun:test';
import { Ghostty } from './ghostty';
import { RowCellsData } from './types';

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
