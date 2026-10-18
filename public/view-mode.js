export function resolveViewMode(urlView, savedView) {
  const value = urlView ?? savedView;
  return value === "2d" ? "2d" : "3d";
}
