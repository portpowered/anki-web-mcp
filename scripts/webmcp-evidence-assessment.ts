export type EvidenceStage = {
  status: string | null;
  failureCode: string | null;
  failureDetail?: string | null;
};

export type WebMcpEvidenceGateInput = {
  oracle: EvidenceStage;
  qualityPassed: boolean;
  localControlsPassed: boolean;
  productionRoutes: EvidenceStage;
  homeJourney: EvidenceStage;
  studyJourney: EvidenceStage;
  suspensionJourney: EvidenceStage;
  adversarialJourney: EvidenceStage;
  lifecycle: EvidenceStage;
  isolation: EvidenceStage;
  browserContextIsolation: EvidenceStage;
  deploymentRevision: EvidenceStage;
};

export type WebMcpEvidenceGateAssessment = {
  overall: "supported" | "no-go" | "not-evaluable";
  downstream: "supported" | "no-go" | "not-evaluable";
  deployedProductionPassed: boolean;
  deployedProductionFailureCode: string | null;
  deployedProductionFailureDetail: string | null;
  failureBoundary: string | null;
};

function passed(stage: EvidenceStage): boolean {
  return stage.status === "passed";
}

/** Require every emitted gate; no aggregate status can mask a failed journey. */
export function assessWebMcpEvidenceGates(
  input: WebMcpEvidenceGateInput,
): WebMcpEvidenceGateAssessment {
  const deployedStages = [
    input.productionRoutes,
    input.homeJourney,
    input.studyJourney,
    input.suspensionJourney,
    input.adversarialJourney,
    input.lifecycle,
  ];
  const failedDeployedStage = deployedStages.find((stage) => !passed(stage));
  const deployedProductionPassed = failedDeployedStage === undefined;
  const deployedProductionFailureCode = failedDeployedStage?.failureCode ??
    (failedDeployedStage ? "production-no-go" : null);
  const deployedProductionFailureDetail = failedDeployedStage?.failureDetail ?? null;
  const oraclePassed = passed(input.oracle);
  const runtimePassed = oraclePassed && input.qualityPassed && input.localControlsPassed &&
    deployedProductionPassed && passed(input.isolation) &&
    passed(input.browserContextIsolation) && passed(input.deploymentRevision);
  const overall = !oraclePassed
    ? "not-evaluable" as const
    : runtimePassed
      ? "supported" as const
      : "no-go" as const;

  let failureBoundary: string | null = null;
  if (!oraclePassed) {
    failureBoundary = `external-oracle:${input.oracle.failureCode ?? "oracle-failed"}`;
  } else if (!input.qualityPassed) {
    failureBoundary = "local-quality-gate-failed";
  } else if (!input.localControlsPassed) {
    failureBoundary = "local-exported-site-control-failed";
  } else if (!deployedProductionPassed) {
    failureBoundary = `deployed-production:${deployedProductionFailureCode}`;
  } else if (!passed(input.isolation)) {
    failureBoundary = `isolation:${input.isolation.failureCode ?? "isolation-no-go"}`;
  } else if (!passed(input.browserContextIsolation)) {
    failureBoundary = `browser-context-isolation:${input.browserContextIsolation.failureCode ?? "context-isolation-no-go"}`;
  } else if (!passed(input.deploymentRevision)) {
    failureBoundary = `deployment-revision:${input.deploymentRevision.failureCode ?? "deployment-revision-no-go"}`;
  }

  return {
    overall,
    downstream: !oraclePassed ? "not-evaluable" : overall,
    deployedProductionPassed,
    deployedProductionFailureCode,
    deployedProductionFailureDetail,
    failureBoundary,
  };
}
