export interface Step {
  do: string;
  via?: string;
  target?: { subject?: string; subjects?: string[]; all?: boolean; allMatching?: boolean };
  [key: string]: unknown;
}
export interface Script {
  name: string;
  about?: string;
  keyboard?: boolean;
  steps: Step[];
  cleanup?: Step[];
}
export interface Mailbox {
  categories: [string, string, string][];
  cases: [string, string, [number, string][]][];
  extras: [string, string, string, [number, string, string][]][];
  others: string[];
}
export interface Observation {
  rows: string[];
  rowState: Record<string, { unread: boolean; starred: boolean; selected: boolean; chips: string[] }>;
  counts: { nav: Record<string, number>; tabs: Record<string, number> };
  selection: number;
  banner: { kind: "page" | "all"; n: number | null; offer: number | null } | null;
  toolbar: string[];
  toast: { text: string; hasUndo: boolean } | null;
  focus: { cursor?: string | null; active: string };
  labels?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface Env {
  side: string;
  keyboard: boolean;
  [method: string]: any;
}
export interface ScriptRun {
  script: string;
  side: string;
  skipped?: string;
  steps: { i: number; step: string; how?: string; error?: string; toastMs?: number | null; obs: Observation | { error: string } }[];
}
export function runScript(script: Script, env: Env, known: string[], opts?: { onStep?: (line: string) => void }): Promise<ScriptRun>;
export function seededSubjects(mailbox: Mailbox): string[];
export function normToolbar(labels: string[]): string[];
export const KEYS: Record<string, string>;
