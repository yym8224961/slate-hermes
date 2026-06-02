const STATIC_ASSET_EXT_RE =
  /\.(?:avif|bmp|css|gif|ico|jpeg|jpg|js|json|map|mjs|otf|png|svg|ttf|txt|wasm|webp|woff|woff2|xml)$/i;

export function isStaticAssetPath(path: string): boolean {
  return STATIC_ASSET_EXT_RE.test(path);
}
