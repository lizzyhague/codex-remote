/**
 * Disambiguate same-name projects only with the already public rootId; real root paths always remain on the backend.
 */
export function projectDisplayLabel(project, projects) {
  if (!project) return "目录不可用";
  const duplicateName = projects.some((candidate) =>
    candidate.id !== project.id && candidate.name === project.name
  );
  return duplicateName ? `${project.name} (${project.rootId})` : project.name;
}
