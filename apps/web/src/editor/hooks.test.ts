// @vitest-environment jsdom
/**
 * `useDocSelector` answers for the editor it's given: a version's preview
 * and the live file count versions apart, so the same number can belong to
 * either (PR 266's review).
 */
import { Editor } from "@drawpane/editor";
import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { EditorContext, useDocSelector } from "./hooks";

function editorWithPage(name: string): Editor {
  const editor = new Editor({ measurer: { width: () => 0 } });
  editor.loadStatic([{ id: "p", parent: ROOT_ID, type: "page", key: "a0", props: { name } }]);
  return editor;
}

const pageName = (doc: { get(id: string): NodeRecord | undefined }) =>
  getProp(doc.get("p")?.props ?? {}, "name");

it("shows the editor it's given, though another was at the same version", () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const live = editorWithPage("Current page");
  const preview = editorWithPage("Historical page");
  expect(live.doc.version).toBe(preview.doc.version);
  function PageName() {
    return createElement("span", null, useDocSelector(pageName));
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  const show = (editor: Editor) => {
    act(() =>
      root.render(
        createElement(EditorContext.Provider, { value: editor }, createElement(PageName)),
      ),
    );
    return host.textContent;
  };
  try {
    expect(show(preview)).toBe("Historical page");
    expect(show(live)).toBe("Current page");
    expect(show(preview)).toBe("Historical page");
  } finally {
    act(() => root.unmount());
  }
});
