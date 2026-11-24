/**
 * @file
 * A project's GitLab CI docker build, with a Dockerfile, for its .gitlab-ci.yml to
 * include. See src/lib/gitlab/serveBuild.ts.
 */
import { serveBuild, type BuildParams } from "@/lib/gitlab/serveBuild";

// Read on every fetch: a changed path or key counts from the next pipeline
export const dynamic = "force-dynamic";

/**
 * @param _request
 * @param context
 * @param context.params
 * @returns
 */
export async function GET(_request: Request, { params }: { params: Promise<BuildParams> }): Promise<Response> {
  return serveBuild("dockerfile", await params);
}
