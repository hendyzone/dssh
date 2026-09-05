export type WritePtyCallback = (terminal: number, userdata: number, dataPtr: number, dataLen: number) => void;
/**
 * SIZE callback: writes its result into out_size (a 12-byte
 * GhosttySizeReportSize struct: rows@0:u16, cols@2:u16, cell_w@4:u32,
 * cell_h@8:u32) and returns 1 to indicate "responded" or 0 to drop the
 * query.
 */
export type SizeCallback = (terminal: number, userdata: number, outSizePtr: number) => number;
/**
 * DECODE_PNG callback: receives PNG bytes at dataPtr / dataLen, decodes
 * to RGBA, allocates a buffer via ghostty_alloc(allocator, rgbaLen),
 * fills the 16-byte GhosttySysImage at outImagePtr (u32 width @ 0,
 * u32 height @ 4, u32 data_ptr @ 8, u32 data_len @ 12), and returns 1
 * on success or 0 to indicate decode failure.
 */
export type DecodePngCallback = (userdata: number, allocator: number, dataPtr: number, dataLen: number, outImagePtr: number) => number;
export interface TrampolineExports {
    writePtyFwd: WritePtyCallback;
    sizeFwd: SizeCallback;
    decodePngFwd: DecodePngCallback;
}
export declare function makeCallbackTrampolines(writePtyCb: WritePtyCallback, sizeCb: SizeCallback, decodePngCb: DecodePngCallback): TrampolineExports;
//# sourceMappingURL=write_pty_trampoline.d.ts.map