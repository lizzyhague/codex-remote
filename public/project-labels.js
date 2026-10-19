/** Interface text from i18n.js; looked up on each call so a language switch applies to the next render. */
const t = (key, params) => globalThis.codexRemoteI18n ? globalThis.codexRemoteI18n.t(key, params) : key;

/**
 * Disambiguate same-name projects only with the already public rootId; real root paths always remain on the backend.
 */
export function projectDisplayLabel(project, projects) {
  if (!project) return t("project.unavailable");
  const duplicateName = projects.some((candidate) =>
    candidate.id !== project.id && candidate.name === project.name
  );
  return duplicateName ? `${project.name} (${project.rootId})` : project.name;
}
