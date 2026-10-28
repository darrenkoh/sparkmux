import { useEffect, useState } from "react";

import { subscribeTabDrag, tabDragHint, tabDraggingId, type TabDragHint } from "./tabReorder";

export function useTabDragIndicator(): {
  draggingId: string | null;
  hint: TabDragHint | null;
} {
  const [state, setState] = useState<{ draggingId: string | null; hint: TabDragHint | null }>({
    draggingId: null,
    hint: null,
  });
  useEffect(
    () =>
      subscribeTabDrag(() => {
        setState({ draggingId: tabDraggingId(), hint: tabDragHint() });
      }),
    [],
  );
  return state;
}
