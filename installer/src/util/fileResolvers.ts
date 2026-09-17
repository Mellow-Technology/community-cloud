/**
 * @file
 * Where a template can be read from.
 *
 * The renderer knows how to read two kinds of path on its own: one of
 * the manifests compiled into this binary, and a file on this machine.
 * Anything else registers itself here.
 *
 * That indirection exists for a reason beyond tidiness. The plugin
 * registry needs the renderer — a plugin's manifest names templates —
 * and the renderer would otherwise need the registry, which closes a
 * loop through the bundle list and the command modules and leaves
 * whichever module is imported first holding half-initialised
 * references to the others. This module imports nothing, so both sides
 * can depend on it and neither has to depend on the other.
 */

/**
 * Something that knows how to read one kind of path.
 */
export interface FileResolver {
  // What this handles, for error messages
  scheme: string;

  // Whether this path is one of its
  matches(path: string): boolean;

  // The file's contents
  read(path: string): string;
}

const resolvers: FileResolver[] = [];

/**
 * Teach the renderer to read another kind of path.
 *
 * @param resolver
 */
export function addFileResolver(resolver: FileResolver) {
  if (!resolvers.some((existing) => existing.scheme === resolver.scheme)) {
    resolvers.push(resolver);
  }
}

/**
 * Read a path, if anything registered here knows how.
 *
 * @param path
 * @returns the contents, or undefined when this isn't anybody's path
 */
export function resolveFile(path: string): string | undefined {
  for (const resolver of resolvers) {
    if (resolver.matches(path)) {
      return resolver.read(path);
    }
  }

  return undefined;
}

/**
 * The schemes that have been registered, for saying what a path could
 * have been.
 *
 * @returns
 */
export function getResolverSchemes(): string[] {
  return resolvers.map((resolver) => resolver.scheme);
}

/**
 * Something that contributes values a template can reference.
 */
export interface ValueContributor {
  // Who is contributing, for the message when two of them collide
  name: string;

  // The values, which may themselves be templates
  values: Record<string, unknown>;
}

const contributors: ValueContributor[] = [];

/**
 * Add values for templates to render against.
 *
 * Applied after everything the installer derives, so a contributor can
 * build its values out of them, and never over the top of a value that
 * is already set.
 *
 * @param contributor
 */
export function addValueContributor(contributor: ValueContributor) {
  contributors.push(contributor);
}

/**
 * @returns everything contributing values
 */
export function getValueContributors(): ValueContributor[] {
  return contributors;
}

/**
 * Forget every registered resolver and contributor. For tests, and for
 * a process that loads more than one configuration.
 */
export function resetFileResolvers() {
  resolvers.length = 0;
  contributors.length = 0;
}
