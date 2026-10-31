import { invoke } from "@tauri-apps/api/core";
/** Native cursor coordinates are physical pixels; browser screenX is not DPI-safe. */
export async function finishTabDrag(cancelled: boolean, open: (position:{x:number;y:number})=>void, id?:string) {
  if(cancelled)return;
  const result=await invoke<{outside:boolean;position:{x:number;y:number}}>("tab_drag_end",{id:id??null});
  if(!id && result.outside)open(result.position);
}
