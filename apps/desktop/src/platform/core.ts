export function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!window.dssh) return Promise.reject(new Error("请使用 Electron 启动 dssh"));
  return window.dssh.invoke(command, args) as Promise<T>;
}
