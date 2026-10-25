import { useEffect, useRef, useState } from "react";

import Modal from "../dialogs/Modal";
import {
  RECIPES,
  canInsertRecipe,
  recipeById,
  recipeCommand,
  recipeProblem,
  type RecipeId,
} from "../terminal/recipes";

export default function RecipesDialog({
  folder,
  command,
  alternate,
  onInsert,
  onCopy,
  onClose,
}: {
  folder: string;
  command: string;
  alternate: boolean;
  onInsert: (command: string) => void;
  onCopy: (command: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<RecipeId | null>(null);
  const [pattern, setPattern] = useState("");
  const patternRef = useRef<HTMLInputElement>(null);
  const recipe = recipeById(selected);
  const built = recipe ? recipeCommand(recipe.id, folder, pattern) : null;
  const problem = recipe ? recipeProblem(recipe, folder, pattern) : null;
  const insertable = canInsertRecipe(command, alternate);
  const shownFolder = folder.trim() || ".";

  useEffect(() => {
    if (recipe?.needsPattern) patternRef.current?.focus();
  }, [recipe?.id, recipe?.needsPattern]);

  function act() {
    if (!built) return;
    if (insertable) onInsert(built);
    else onCopy(built);
  }

  return (
    <Modal title="Frequently Used Command" onClose={onClose} className="recipe-modal">
      <p className="recipe-folder">Folder: {shownFolder}</p>
      <div className="recipe-list" role="listbox" aria-label="Shell recipes">
        {RECIPES.map((item) => (
          <button
            key={item.id}
            type="button"
            className="recipe-job"
            role="option"
            aria-selected={item.id === selected}
            onClick={() => setSelected(item.id)}
          >
            <strong>{item.label}</strong>
            <span>{item.hint}</span>
          </button>
        ))}
      </div>
      {recipe?.needsPattern && (
        <label className="recipe-pattern">
          {recipe.patternLabel}
          <input
            ref={patternRef}
            value={pattern}
            placeholder={recipe.patternPlaceholder}
            onChange={(event) => setPattern(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") act();
              if (event.key === "Escape") onClose();
            }}
          />
        </label>
      )}
      {built && <pre className="recipe-preview">{built}</pre>}
      {recipe && problem && <p className="hint">{problem}</p>}
      {recipe && !insertable && (
        <p className="hint">This pane is not a shell. Copy the command.</p>
      )}
      <div className="modal-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={!built} onClick={act}>
          {insertable ? "Insert" : "Copy"}
        </button>
      </div>
    </Modal>
  );
}
