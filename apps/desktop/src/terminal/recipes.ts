// Fixed shell recipes. The app fills the folder and the quotes.
// The command is inserted into a normal shell and is not run.

export type RecipeId =
  | "folder-size"
  | "folder-usage"
  | "free-space"
  | "find-name"
  | "grep-text";

export interface Recipe {
  id: RecipeId;
  label: string;
  hint: string;
  needsPattern: boolean;
  patternLabel: string;
  patternPlaceholder: string;
}

export const RECIPES: readonly Recipe[] = [
  {
    id: "folder-size",
    label: "Folder size",
    hint: "Total size of this folder",
    needsPattern: false,
    patternLabel: "",
    patternPlaceholder: "",
  },
  {
    id: "folder-usage",
    label: "What is using the space",
    hint: "Size of each item in this folder",
    needsPattern: false,
    patternLabel: "",
    patternPlaceholder: "",
  },
  {
    id: "free-space",
    label: "Free space",
    hint: "Free space on the disk that holds this folder",
    needsPattern: false,
    patternLabel: "",
    patternPlaceholder: "",
  },
  {
    id: "find-name",
    label: "Files by name",
    hint: "Find files whose name matches",
    needsPattern: true,
    patternLabel: "Name",
    patternPlaceholder: "*.log",
  },
  {
    id: "grep-text",
    label: "Text inside files",
    hint: "Find lines that contain this text",
    needsPattern: true,
    patternLabel: "Text",
    patternPlaceholder: "TODO",
  },
];

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash"]);

export function recipeById(id: RecipeId | null): Recipe | null {
  if (!id) return null;
  return RECIPES.find((recipe) => recipe.id === id) ?? null;
}

/** Login shells arrive as `-zsh`. tmux may report a full path. */
export function shellName(command: string): string {
  const base = command.trim().split(/[/\\]/).pop() ?? "";
  return base.startsWith("-") ? base.slice(1) : base;
}

/** A normal shell can take a typed command. An agent or full-screen program cannot. */
export function canInsertRecipe(command: string, alternate: boolean): boolean {
  if (alternate) return false;
  return SHELLS.has(shellName(command));
}

export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function quoteFolder(folder: string): string {
  const dir = folder.trim() || ".";
  if (dir === ".") return ".";
  return shellQuote(dir);
}

function hasControl(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Why a selected recipe cannot build a command yet. Null means it can. */
export function recipeProblem(
  recipe: Recipe,
  folder: string,
  pattern: string,
): string | null {
  if (hasControl(folder)) return "This folder path cannot go into a command.";
  if (!recipe.needsPattern) return null;
  if (!pattern.trim()) {
    return recipe.id === "find-name" ? "Type a name." : "Type the text to find.";
  }
  if (hasControl(pattern)) return "That text cannot go into a command.";
  return null;
}

/** One finished command, or null when the pattern or folder cannot be used. */
export function recipeCommand(
  id: RecipeId,
  folder: string,
  pattern: string,
): string | null {
  const recipe = recipeById(id);
  if (!recipe || recipeProblem(recipe, folder, pattern)) return null;
  const dir = quoteFolder(folder);
  if (id === "folder-size") return `du -sh ${dir}`;
  if (id === "folder-usage") return `du -hd 1 ${dir}`;
  if (id === "free-space") return `df -h ${dir}`;
  const quoted = shellQuote(pattern.trim());
  if (id === "find-name") return `find ${dir} -name ${quoted}`;
  return `grep -R -n -F -- ${quoted} ${dir}`;
}
