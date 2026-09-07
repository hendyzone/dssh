import {render,screen,fireEvent,waitFor} from "@testing-library/react";
import {it,expect,vi} from "vitest";
import {invoke} from "@tauri-apps/api/core";
import SftpPanel from "../src/components/SftpPanel";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn().mockResolvedValue(()=>{})}));
vi.mock("@tauri-apps/plugin-dialog",()=>({open:vi.fn()}));
vi.mock("../src/lib/transfers",()=>({subscribeTransfers:()=>()=>{},createTransfer:()=>"transfer",waitForTransferListener:async()=>{},formatTransferSize:()=>"",transferPercent:()=>0}));
function setup(){ vi.mocked(invoke).mockImplementation(async(command,args:any)=>{
  if(command === "sftp_home")return "/home/demo";
  if(command === "sftp_list")return args.path === "/home/demo/project" ? [{name:"readme.md",path:"/home/demo/project/readme.md",isDir:false}] : [{name:".config",path:"/home/demo/.config",isDir:false},{name:"project",path:"/home/demo/project",isDir:true}];
  if(command === "sftp_read_text")return "original";
  if(command === "sftp_save_text")return "backup";
  return [];
}); render(<SftpPanel sessionId="session" onClose={()=>{}}/>); }
it("enters a resolved directory link without downloading it",async()=>{
 vi.mocked(invoke).mockClear();
 vi.mocked(invoke).mockImplementation(async(command,args:any)=>{
  if(command === "sftp_home")return "/home/demo";
  if(command === "sftp_list")return args.path === "/home/demo" ? [{name:"workspace",path:"/home/demo/workspace",isDir:true}] : [];
  return [];
 });
 render(<SftpPanel sessionId="session" onClose={()=>{}}/>);
 fireEvent.doubleClick(await screen.findByText("workspace"));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith("sftp_list",{sessionId:"session",path:"/home/demo/workspace"}));
 expect(vi.mocked(invoke).mock.calls.some(([command])=>command === "sftp_download")).toBe(false);
});
it("opens the displayed remote folder with the selected saved connection",async()=>{
 vi.mocked(invoke).mockImplementation(async(command)=>command === "sftp_home" ? "/home/demo/project space" : []);
 render(<SftpPanel sessionId="session" serverId="saved-server" onClose={()=>{}}/>);
 await waitFor(()=>expect((screen.getByLabelText("远程路径") as HTMLInputElement).value).toBe("/home/demo/project space"));
 fireEvent.click(screen.getByRole("button",{name:"VS Code 远程打开"}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith("vscode_open",{serverId:"saved-server",path:"/home/demo/project space"}));
});
it("starts at home, toggles dotfiles and expands directories without leaving the root",async()=>{
 setup();await screen.findByText(".config");fireEvent.click(screen.getByRole("button",{name:"隐藏文件 开"}));expect(screen.queryByText(".config")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"展开 project"}));await screen.findByText("readme.md");expect((screen.getByLabelText("远程路径") as HTMLInputElement).value).toBe("/home/demo");
});
it("sends the original text with edits so the backend can reject remote conflicts",async()=>{
 setup();await screen.findByText(".config");fireEvent.click(screen.getByTitle("在线编辑"));await screen.findByRole("dialog");fireEvent.change(screen.getByLabelText("文件内容"),{target:{value:"modified"}});fireEvent.click(screen.getByRole("button",{name:"保存到远程"}));await waitFor(()=>expect(invoke).toHaveBeenCalledWith("sftp_save_text",{sessionId:"session",path:"/home/demo/.config",original:"original",content:"modified"}));
});

it("renders Markdown safely and keeps edits when switching modes",async()=>{
 vi.mocked(invoke).mockImplementation(async(command)=>command==="sftp_home"?"/home/demo":command==="sftp_list"?[{name:"README.md",path:"/home/demo/README.md",isDir:false}]:command==="sftp_read_text"?"# Preview title\n\n<script>alert(1)</script>":[]);
 render(<SftpPanel sessionId="session" onClose={()=>{}}/>);await screen.findByText("README.md");fireEvent.click(screen.getByTitle("在线编辑"));await screen.findByRole("heading",{name:"Preview title"});expect(document.querySelector("article script")).toBeNull();fireEvent.click(screen.getByRole("button",{name:"编辑源码"}));fireEvent.change(screen.getByLabelText("文件内容"),{target:{value:"# Edited title"}});fireEvent.click(screen.getByRole("button",{name:"渲染预览"}));expect(screen.getByRole("heading",{name:"Edited title"})).toBeTruthy();
});
