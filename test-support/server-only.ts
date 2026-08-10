/**
 * A stand-in for Next's `server-only` package.
 *
 * That package exists to make a build fail if server code is imported into a
 * client bundle. It has no runtime behaviour and no resolvable entry point
 * outside Next's bundler, so anything importing it — which is every module in
 * app/lib — could not be unit tested at all. Aliased to this empty module so
 * they can be, while the real guard still applies to the real build.
 */
export {};
