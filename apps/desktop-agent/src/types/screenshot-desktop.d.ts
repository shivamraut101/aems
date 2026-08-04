declare module "screenshot-desktop" {
  function screenshot(options?: { filename?: string; format?: "png" | "jpg" }): Promise<Buffer>;
  export default screenshot;
}
