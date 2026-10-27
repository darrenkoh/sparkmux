/** OS window and document title. `version` is the running build, for example `0.1.64`. */
export function formatAppWindowTitle(version: string): string {
  return version ? `SparkMux ${version}` : "SparkMux";
}
