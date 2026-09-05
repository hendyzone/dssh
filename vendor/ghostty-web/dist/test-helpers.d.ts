import { ITerminalOptions } from './interfaces';
import { Terminal } from './terminal';
/**
 * Creates a Terminal instance with an isolated Ghostty WASM instance.
 * This ensures complete test isolation with no shared state between tests.
 *
 * @param options - Terminal options (cols, rows, etc.)
 * @returns Promise resolving to Terminal instance
 *
 * @example
 * ```typescript
 * import { createIsolatedTerminal } from './test-helpers';
 *
 * describe('My Tests', () => {
 *   test('my test', async () => {
 *     const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
 *     term.open(container);
 *     // ... test logic ...
 *     term.dispose();
 *   });
 * });
 * ```
 */
export declare function createIsolatedTerminal(options?: Omit<ITerminalOptions, 'ghostty'>): Promise<Terminal>;
//# sourceMappingURL=test-helpers.d.ts.map