import {afterEach,expect,it} from "vitest";
import {readFileSync} from "node:fs";
const css=readFileSync("src/components/Collaboration.css","utf8");
let style:HTMLStyleElement|undefined;
let fixture:HTMLDivElement|undefined;
afterEach(()=>{style?.remove();fixture?.remove();});
it("reserves the status-dot track and puts direct card AI content on its own row",()=>{
 style=document.createElement("style");style.textContent=css;document.head.append(style);
 fixture=document.createElement("div");fixture.className="team-dynamics";
 const row=document.createElement("details");row.className="team-live-card";
 const head=document.createElement("summary");head.className="team-card-head";
 const ai=document.createElement("span");ai.className="team-service-ai";ai.textContent="An intentionally wide AI summary";
 head.append(ai);row.append(head);fixture.append(row);document.body.append(fixture);
 expect(getComputedStyle(head).gridTemplateColumns).toBe("7px minmax(0,1fr) auto auto");
 expect(getComputedStyle(ai).gridColumn).toBe("1/-1");
 expect(getComputedStyle(ai).minWidth).toBe("0");
 const nested=document.createElement("span");nested.className="team-service-ai";ai.append(nested);
 expect(getComputedStyle(nested).gridColumn).not.toBe("1/-1");
});
it.each(["team-card-head","team-compact-head"])("left-aligns and bounds the identity in %s without losing ellipsis",headClass=>{
 style=document.createElement("style");style.textContent=css;document.head.append(style);
 fixture=document.createElement("div");fixture.className="team-dynamics";
 const head=document.createElement("summary");head.className=headClass;
 const name=document.createElement("strong");name.className="team-ai-identity";name.textContent="A long member name";head.append(name);fixture.append(head);document.body.append(fixture);
 const computed=getComputedStyle(name);
 expect(computed.textAlign).toBe("left");expect(computed.justifySelf).toBe("start");
 expect(computed.maxWidth).toBe("100%");expect(computed.minWidth).toBe("0");
 expect(computed.overflow).toBe("hidden");expect(computed.textOverflow).toBe("ellipsis");
});
