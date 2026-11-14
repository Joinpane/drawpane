// Vite's `?inline` imports: a file's bytes as a data: URL (test fixtures).
declare module "*?inline" {
  const url: string;
  export default url;
}
