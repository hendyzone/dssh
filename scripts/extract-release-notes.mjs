import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export function extractReleaseNotes(markdown, version) {
  const sections = [...markdown.matchAll(/^##\s+v([^\s（(]+)[^\n]*$/gm)];
  const index = sections.findIndex(match => match[1] === version.replace(/^v/, ''));
  if (index < 0) throw new Error(`CHANGELOG.md 缺少 v${version.replace(/^v/, '')} 版本说明`);
  const start = sections[index].index;
  const nextHeading = markdown.slice(start + sections[index][0].length).search(/^##\s/m);
  const end = nextHeading < 0 ? markdown.length : start + sections[index][0].length + nextHeading;
  const section = markdown.slice(start, end).trim();
  if (!section.slice(sections[index][0].length).trim()) throw new Error('版本说明不能为空');
  return section;
}

export function main() {
  const config = JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'));
  if (process.env.GITHUB_REF_NAME !== `v${config.version}`) {
    throw new Error(`tag 必须与应用版本 v${config.version} 一致`);
  }
  const notes = extractReleaseNotes(readFileSync('CHANGELOG.md', 'utf8'), config.version);
  if (process.env.GITHUB_OUTPUT) {
    const delimiter = `notes_${randomUUID()}`;
    appendFileSync(process.env.GITHUB_OUTPUT, `body<<${delimiter}\n${notes}\n${delimiter}\n`, 'utf8');
  } else {
    console.log(notes);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
