export {};
declare global {
  interface Window {
    dssh?: {
      invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
      listen(event: string, handler: (payload: unknown) => void): () => void;
      filePath(file: File): string;
    };
  }
}
