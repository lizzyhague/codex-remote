/**
 * 同名项目只使用已经公开的 rootId 消歧；真实根路径始终留在后端。
 */
export function projectDisplayLabel(project, projects) {
  if (!project) return "目录不可用";
  const duplicateName = projects.some((candidate) =>
    candidate.id !== project.id && candidate.name === project.name
  );
  return duplicateName ? `${project.name} (${project.rootId})` : project.name;
}
