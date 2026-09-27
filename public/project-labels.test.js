import assert from "node:assert/strict";
import test from "node:test";

import { projectDisplayLabel } from "./project-labels.js";

test("same-named projects use the public root id while unique names stay concise", () => {
  const projects = [
    { id: "work/demo", name: "demo", rootId: "work" },
    { id: "archive/demo", name: "demo", rootId: "archive" },
    { id: "work/notes", name: "notes", rootId: "work" },
  ];

  assert.deepEqual(
    projects.map((project) => projectDisplayLabel(project, projects)),
    ["demo (work)", "demo (archive)", "notes"],
  );
  assert.equal(projectDisplayLabel(undefined, projects), "目录不可用");
});
