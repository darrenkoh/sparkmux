// Fixed shell recipes. The app fills the folder and the quotes.
// The command is inserted into a normal shell and is not run.

export type RecipeId =
  | "folder-size"
  | "folder-usage"
  | "free-space"
  | "list-folder"
  | "file-count"
  | "changed-today"
  | "find-name"
  | "find-iname"
  | "grep-text"
  | "grep-text-i"
  | "git-status"
  | "git-diff";

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
    id: "list-folder",
    label: "List this folder",
    hint: "Names, sizes, and hidden files",
    needsPattern: false,
    patternLabel: "",
    patternPlaceholder: "",
  },
  {
    id: "file-count",
    label: "How many files",
    hint: "Count the files under this folder",
    needsPattern: false,
    patternLabel: "",
    patternPlaceholder: "",
  },
  {
    id: "changed-today",
    label: "Files changed today",
    hint: "Files modified in the last day",
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
    id: "find-iname",
    label: "Name, ignoring case",
    hint: "Find files by name, upper or lower case",
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
  {
    id: "grep-text-i",
    label: "Text, ignoring case",
    hint: "Find lines that contain this text, in any case",
    needsPattern: true,
    patternLabel: "Text",
    patternPlaceholder: "TODO",
  },
  {
    id: "git-status",
    label: "Git status",
    hint: "Short status of the repo that holds this folder",
    needsPattern: false,
    patternLabel: "",
    patternPlaceholder: "",
  },
  {
    id: "git-diff",
    label: "Git diff",
    hint: "Summary of uncommitted changes",
    needsPattern: false,
    patternLabel: "",
    patternPlaceholder: "",
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
    return recipe.patternLabel === "Name" ? "Type a name." : "Type the text to find.";
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
  if (id === "list-folder") return `ls -lah ${dir}`;
  if (id === "file-count") return `find ${dir} -type f | wc -l`;
  if (id === "changed-today") return `find ${dir} -type f -mtime -1`;
  if (id === "git-status") return `git -C ${dir} status -sb`;
  if (id === "git-diff") return `git -C ${dir} diff --stat`;
  const quoted = shellQuote(pattern.trim());
  if (id === "find-name") return `find ${dir} -name ${quoted}`;
  if (id === "find-iname") return `find ${dir} -iname ${quoted}`;
  if (id === "grep-text") return `grep -R -n -F -- ${quoted} ${dir}`;
  return `grep -R -n -F -i -- ${quoted} ${dir}`;
}
