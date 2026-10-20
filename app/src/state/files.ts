// Downloads and opening attachments, as a browser would: a download goes straight into the Downloads folder
// (named "file (1).pdf" when the name is taken), and opening a file hands it to the app the Mac uses for it.
import { api, failureText } from "../ipc/api";
import { toast } from "./store";

export function downloadName(subject: string, ext: string): string {
  return `${
    (subject || "message")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .trim()
      .slice(0, 80) || "message"
  }.${ext}`;
}

export async function download(name: string, data: Uint8Array): Promise<string | null> {
  try {
    const path = await api.saveDownload(name, data);
    const saved = path.split("/").pop() || name;
    toast(`${saved} saved to Downloads.`, { action: { label: "Show in Finder", run: () => void api.revealFile(path) } });
    return path;
  } catch (e) {
    toast(failureText(`save ${name}`, e));
    return null;
  }
}

export async function downloadAll(items: { name: string; data: Uint8Array }[]): Promise<void> {
  const paths: string[] = [];
  for (const it of items) {
    try {
      paths.push(await api.saveDownload(it.name, it.data));
    } catch (e) {
      toast(failureText(`save ${it.name}`, e));
      return;
    }
  }
  if (paths.length) toast(`${paths.length} files saved to Downloads.`, { action: { label: "Show in Finder", run: () => void api.revealFile(paths[0]) } });
}

export async function openInApp(name: string, data: Uint8Array): Promise<void> {
  try {
    await api.openFile(name, data);
  } catch (e) {
    toast(failureText(`open ${name}`, e));
  }
}
