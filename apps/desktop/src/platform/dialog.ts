import { invoke } from "./core";
interface OpenOptions {
  title?: string;
  multiple?: boolean;
  directory?: boolean;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}
export const open = (options: OpenOptions = {}) => invoke<string | string[] | null>("desktop_open_dialog", { options });
export const confirm = (message: string, options: { title?: string; kind?: string; okLabel?: string; cancelLabel?: string } = {}) =>
  invoke<boolean>("desktop_confirm", { message, options });
