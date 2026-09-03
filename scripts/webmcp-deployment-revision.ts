export type DeploymentRevisionEvidence = {
  repository: string;
  environment: string;
  requiredOrigin: string;
  localHeadCommit: string | null;
  finalMainCommit: string | null;
  deployedCommit: string | null;
  deploymentStatus: string | null;
  deploymentUrl: string | null;
  observedAt: string;
  failure: string | null;
};

export type DeploymentRevisionAssessment = {
  status: "passed" | "failed";
  failureCode: string | null;
};

type GitHubDeployment = { id?: number; sha?: string };
type GitHubDeploymentStatus = { state?: string; environment_url?: string };

const commitPattern = /^[0-9a-f]{40}$/;

/** Require one exact successful Pages revision; branch or stale deployments fail closed. */
export function assessDeploymentRevision(
  evidence: DeploymentRevisionEvidence,
): DeploymentRevisionAssessment {
  if (evidence.failure) {
    return { status: "failed", failureCode: "deployment-revision-unavailable" };
  }
  const commits = [evidence.localHeadCommit, evidence.finalMainCommit, evidence.deployedCommit];
  if (commits.some((commit) => !commit || !commitPattern.test(commit))) {
    return { status: "failed", failureCode: "deployment-revision-invalid" };
  }
  if (new Set(commits).size !== 1) {
    return { status: "failed", failureCode: "deployment-revision-mismatch" };
  }
  if (evidence.deploymentStatus !== "success") {
    return { status: "failed", failureCode: "deployment-not-successful" };
  }
  let deploymentOrigin: string | null = null;
  try {
    deploymentOrigin = evidence.deploymentUrl ? new URL(evidence.deploymentUrl).origin : null;
  } catch {
    deploymentOrigin = null;
  }
  if (deploymentOrigin !== evidence.requiredOrigin) {
    return { status: "failed", failureCode: "deployment-origin-mismatch" };
  }
  return { status: "passed", failureCode: null };
}

export async function inspectDeploymentRevision(
  repositoryRoot: string,
  requiredOrigin: string,
): Promise<DeploymentRevisionEvidence> {
  const evidence: DeploymentRevisionEvidence = {
    repository: "portpowered/anki-web-mcp",
    environment: "github-pages",
    requiredOrigin,
    localHeadCommit: null,
    finalMainCommit: null,
    deployedCommit: null,
    deploymentStatus: null,
    deploymentUrl: null,
    observedAt: new Date().toISOString(),
    failure: null,
  };
  try {
    const local = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repositoryRoot });
    if (local.exitCode !== 0) throw new Error("local-head-unavailable");
    evidence.localHeadCommit = local.stdout.toString().trim();
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "anki-web-mcp-evidence",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const api = async <T>(path: string): Promise<T> => {
      const response = await fetch(`https://api.github.com/repos/${evidence.repository}/${path}`, { headers });
      if (!response.ok) throw new Error(`github-api-${response.status}`);
      return await response.json() as T;
    };
    const main = await api<{ sha?: string }>("commits/main");
    evidence.finalMainCommit = main.sha ?? null;
    const deployments = await api<GitHubDeployment[]>(
      "deployments?environment=github-pages&per_page=1",
    );
    const deployment = deployments[0];
    evidence.deployedCommit = deployment?.sha ?? null;
    if (typeof deployment?.id === "number") {
      const statuses = await api<GitHubDeploymentStatus[]>(
        `deployments/${deployment.id}/statuses?per_page=1`,
      );
      evidence.deploymentStatus = statuses[0]?.state ?? null;
      evidence.deploymentUrl = statuses[0]?.environment_url ?? null;
    }
  } catch (error) {
    evidence.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return evidence;
}
